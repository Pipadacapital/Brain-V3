/**
 * ErasureRequestQueueRepository — the PG request queue behind the DPDP/PDPL erasure lane
 * (ops.erasure_request_queue, migration 0140 — ADR-0015 WS4 completion).
 *
 * Replaces the Kafka consumer discipline (offset-commit ordering + Redis retry counter +
 * DLQ producer) of the retired ErasureOrchestratorConsumer with durable row-state:
 *
 *   requested  → the durable trigger core enqueued (the produce-ack equivalent).
 *   processing → claimed by a worker (the uncommitted-offset equivalent). Stale processing
 *                rows (worker crash mid-sequence) are requeued — the redelivery Kafka gave
 *                us via uncommitted offsets; the erasure sequence is idempotent (D-4).
 *   done       → EraseSubjectUseCase returned (erased or a sanctioned skip outcome).
 *                Payload is CLEARED (raw subject PII must not outlive the request).
 *   dead       → poison: attempts >= MAX, or an 'invalid' envelope (no retry helps).
 *                The PG replacement for collector.event.v1.dlq — payload kept for
 *                operator forensics/redrive (the DLQ retained 30d).
 *
 * PER-BRAND ORDERING (CRITICAL — mirrors Kafka's partition-by-brand_id): claimBatch() only
 * takes the OLDEST pending-or-processing row per brand (the head). While a brand's head is
 * processing (any replica) or parked on retry backoff, NO other row of that brand is
 * claimable — exactly the serialization the single-partition-per-brand consumer had, so two
 * erasures for the same subject (or brand) can never interleave. FOR UPDATE SKIP LOCKED
 * makes the head claim race-safe across replicas.
 *
 * TENANT ISOLATION: cross-brand trusted-ETL queue (no brand GUC — like ops.restitch_pending);
 * isolation is the explicit brand_id column, and every downstream write in the use case is
 * (brand_id, brain_id)-scoped. Connects as brain_app (SELECT/INSERT/UPDATE grants only).
 */
import { Pool } from 'pg';

export interface ClaimedErasureRequest {
  /** Queue PK = the trigger envelope's event_id. */
  id: string;
  brandId: string;
  subjectKind: string;
  /** brain_id UUID or unsalted sha256 digest — ops handle only, never raw PII. */
  subjectRef: string;
  source: string;
  /** The CollectorEventV1-shaped trigger envelope (null only on a corrupted row). */
  payload: Record<string, unknown> | null;
  /** Attempts BEFORE this claim (0 on first delivery). */
  attempts: number;
  requestedAt: Date;
}

export interface IErasureRequestQueueRepository {
  /**
   * Requeue 'processing' rows claimed longer than staleMs ago (worker crash mid-sequence) back
   * to 'requested' — the redelivery semantics an uncommitted Kafka offset provided. Returns the
   * requeued count. Does NOT bump attempts (a crash is not a write error; the retry budget is
   * for failing writes, matching the old consumer whose counter only moved on a thrown error).
   */
  requeueStaleProcessing(staleMs: number): Promise<number>;

  /**
   * Atomically claim up to `limit` due rows — ONLY each brand's queue head (see class doc) —
   * flipping them to 'processing'. Rows claimed by another replica are skipped (SKIP LOCKED).
   */
  claimBatch(limit: number): Promise<ClaimedErasureRequest[]>;

  /**
   * Terminal success (erased or sanctioned skip). Clears the payload: the raw subject PII in
   * the trigger envelope must not outlive the request it served (the Kafka copy aged out with
   * topic retention; a durable PG row would not).
   */
  markDone(id: string, outcome: string): Promise<void>;

  /** Write error: back to 'requested' with attempts+1 and a backoff-delayed next_attempt_at. */
  markRetry(id: string, attempts: number, lastError: string, backoffMs: number): Promise<void>;

  /** Poison (attempts >= MAX, or an invalid envelope). Payload kept for operator forensics. */
  markDead(id: string, attempts: number, lastError: string, outcome: string): Promise<void>;

  end(): Promise<void>;
}

export class ErasureRequestQueueRepository implements IErasureRequestQueueRepository {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    // brain_app credentials — cross-brand trusted-ETL queue, no brand GUC (0140).
    this.pool = new Pool({
      connectionString,
      max: 2,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
  }

  async requeueStaleProcessing(staleMs: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ops.erasure_request_queue
          SET status = 'requested',
              next_attempt_at = now(),
              updated_at = now(),
              last_error = 'requeued: stale processing claim (worker crash mid-sequence?)'
        WHERE status = 'processing'
          AND claimed_at < now() - make_interval(secs => $1::double precision / 1000.0)`,
      [staleMs],
    );
    return result.rowCount ?? 0;
  }

  async claimBatch(limit: number): Promise<ClaimedErasureRequest[]> {
    // head: the earliest pending-or-processing row per brand — Kafka's per-brand partition
    // order. claimable: the head, only if it is 'requested' AND due (a processing or
    // backoff-parked head blocks its brand, like an uncommitted/stuck offset did).
    const result = await this.pool.query(
      `WITH head AS (
         SELECT DISTINCT ON (brand_id) id
           FROM ops.erasure_request_queue
          WHERE status IN ('requested', 'processing')
          ORDER BY brand_id, requested_at, id
       ),
       claimable AS (
         SELECT q.id
           FROM ops.erasure_request_queue q
           JOIN head h ON h.id = q.id
          WHERE q.status = 'requested'
            AND q.next_attempt_at <= now()
          ORDER BY q.requested_at, q.id
          LIMIT $1
          FOR UPDATE OF q SKIP LOCKED
       )
       UPDATE ops.erasure_request_queue t
          SET status = 'processing', claimed_at = now(), updated_at = now()
         FROM claimable c
        WHERE t.id = c.id
       RETURNING t.id, t.brand_id, t.subject_kind, t.subject_ref, t.source,
                 t.payload, t.attempts, t.requested_at`,
      [limit],
    );
    return result.rows
      .map((r: Record<string, unknown>): ClaimedErasureRequest => ({
        id: String(r['id']),
        brandId: String(r['brand_id']),
        subjectKind: String(r['subject_kind']),
        subjectRef: String(r['subject_ref']),
        source: String(r['source']),
        payload: (r['payload'] as Record<string, unknown> | null) ?? null,
        attempts: Number(r['attempts']),
        requestedAt: r['requested_at'] as Date,
      }))
      // Batch order = claim order (requested_at, id) — process oldest first.
      .sort((a, b) =>
        a.requestedAt.getTime() - b.requestedAt.getTime() || (a.id < b.id ? -1 : 1),
      );
  }

  async markDone(id: string, outcome: string): Promise<void> {
    await this.pool.query(
      `UPDATE ops.erasure_request_queue
          SET status = 'done', outcome = $2, payload = NULL, last_error = NULL,
              updated_at = now()
        WHERE id = $1`,
      [id, outcome],
    );
  }

  async markRetry(id: string, attempts: number, lastError: string, backoffMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE ops.erasure_request_queue
          SET status = 'requested', attempts = $2, last_error = $3,
              next_attempt_at = now() + make_interval(secs => $4::double precision / 1000.0),
              updated_at = now()
        WHERE id = $1`,
      [id, attempts, lastError, backoffMs],
    );
  }

  async markDead(id: string, attempts: number, lastError: string, outcome: string): Promise<void> {
    await this.pool.query(
      `UPDATE ops.erasure_request_queue
          SET status = 'dead', attempts = $2, last_error = $3, outcome = $4,
              updated_at = now()
        WHERE id = $1`,
      [id, attempts, lastError, outcome],
    );
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
