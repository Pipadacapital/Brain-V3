/**
 * SpoolRepository interface — domain boundary for spool persistence.
 * Concrete implementation lives in infrastructure/.
 */
import type { ClientBase } from 'pg';
import type { IngestEnvelope } from '../value-objects/envelope.js';
import type { PendingSpoolEntry } from '../entities/spool-entry.js';

/**
 * A transactional claim over a batch of pending spool rows (AUD-PERF-006).
 *
 * The claimed rows are ROW-LOCKED (FOR UPDATE SKIP LOCKED) for the lifetime of the claim, so a
 * concurrent drain pass — an overlapping tick or a second collector replica — skips them instead
 * of double-producing. Exactly one of commit()/rollback() must settle the claim; both are
 * idempotent. A process crash mid-claim releases the locks automatically (the transaction
 * aborts server-side) and every row stays 'pending' — the no-event-loss invariant holds.
 */
export interface SpoolClaim {
  /** Rows claimed by this drain pass, ordered by id (oldest first). */
  readonly entries: PendingSpoolEntry[];

  /**
   * The pooled PG client that owns the claim transaction (ADR-0012). The drainer runs the ingest
   * dedup write (data_plane.mark_events_seen) on THIS client so mark-seen commits atomically with
   * markDrained — a separate connection/txn would break that atomicity. Read-only handle; settle
   * the claim via commit()/rollback(), never a raw COMMIT on this client.
   */
  readonly client: ClientBase;

  /**
   * Mark claimed rows as drained (status='drained', drained_at=now()) INSIDE the claim
   * transaction. The marks become durable only at commit().
   */
  markDrained(ids: bigint[]): Promise<void>;

  /** Commit the claim — drained marks become durable, row locks release. Idempotent. */
  commit(): Promise<void>;

  /** Abort the claim — every row stays 'pending', row locks release. Idempotent. */
  rollback(): Promise<void>;
}

export interface SpoolRepository {
  /**
   * Write a raw envelope to the spool. Returns the new row id.
   * This INSERT is the ACK boundary — it commits before HTTP 200 is returned.
   */
  insert(envelope: IngestEnvelope): Promise<bigint>;

  /**
   * Write a batch of raw envelopes in ONE multi-row INSERT (AUD-PERF-007) — a single durable
   * commit that still precedes the /batch ACK (D-1), instead of N sequential round-trips.
   * Returns the new row ids in input order. Atomic: the whole batch spools or none does
   * (the 500-retry client contract then re-sends the batch).
   */
  insertMany(envelopes: IngestEnvelope[]): Promise<bigint[]>;

  /**
   * Atomically claim up to `limit` pending rows, ordered by id (oldest first), row-locking them
   * against concurrent drain passes (FOR UPDATE SKIP LOCKED). Used by the drainer loop.
   */
  claimPending(limit: number): Promise<SpoolClaim>;

  /**
   * Count pending rows, but stop scanning once `cap` is reached (a BOUNDED count).
   * Returns min(actual_pending, cap). Backs the spool back-pressure gauge (C4 / R-09):
   * we only need to know whether the backlog has crossed the high/low-water marks, never
   * the true depth — so the query is O(cap) on the partial pending index, not O(table).
   */
  countPendingBounded(cap: number): Promise<number>;

  /**
   * Retention reaper (DB-AUDIT M6): delete rows that have been 'drained' for longer than
   * `olderThanSeconds` (a short post-drain trail window). Returns the number of rows purged.
   * Bounds collector_spool growth — drained rows are disposable once produced to Kafka.
   */
  reapDrained(olderThanSeconds: number): Promise<number>;

  /**
   * Health check — can the spool DB be reached?
   * Returns true if a simple query succeeds.
   */
  ping(): Promise<boolean>;
}
