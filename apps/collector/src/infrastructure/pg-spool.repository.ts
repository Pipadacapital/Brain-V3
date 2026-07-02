/**
 * Postgres implementation of SpoolRepository.
 *
 * Connects as brain_app (NOT brain superuser) so RLS and GRANT checks fire.
 * collector_spool has NO RLS — this is intentional (pre-brand-validation edge).
 * brain_app has SELECT + INSERT + UPDATE on collector_spool (migration 0015).
 *
 * Connection: uses the DATABASE_URL env var but switches to brain_app role.
 * In practice the env var should point to a connection string with the brain_app
 * credentials. For dev the superuser 'brain' is used with SET ROLE brain_app
 * to simulate the production role boundary.
 */
import pg from 'pg';
import type { SpoolClaim, SpoolRepository } from '../domain/ingest/repositories/spool.repository.js';
import type { IngestEnvelope } from '../domain/ingest/value-objects/envelope.js';
import type { PendingSpoolEntry } from '../domain/ingest/entities/spool-entry.js';
import { log } from '../log.js';

const { Pool } = pg;

export class PgSpoolRepository implements SpoolRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  async insert(envelope: IngestEnvelope): Promise<bigint> {
    const payload = {
      ...envelope.rawBody,
      _received_at: envelope.receivedAt,
    };

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO collector_spool (raw_body, received_at, status)
       VALUES ($1::jsonb, $2::timestamptz, 'pending')
       RETURNING id::text`,
      [JSON.stringify(payload), envelope.receivedAt],
    );

    const row = result.rows[0];
    if (!row) throw new Error('[spool] INSERT returned no row');
    return BigInt(row.id);
  }

  async insertMany(envelopes: IngestEnvelope[]): Promise<bigint[]> {
    if (envelopes.length === 0) return [];

    // Same payload shape as insert(): the received_at stamp rides on the body too.
    const bodies = envelopes.map((e) => JSON.stringify({ ...e.rawBody, _received_at: e.receivedAt }));
    const receivedAts = envelopes.map((e) => e.receivedAt);

    // ONE multi-row INSERT (AUD-PERF-007): a /batch of 50 events is a single PG round-trip +
    // commit instead of 50 sequential ones, and holds a pool connection for one statement only.
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO collector_spool (raw_body, received_at, status)
       SELECT body::jsonb, received_at, 'pending'
       FROM unnest($1::text[], $2::timestamptz[]) AS t(body, received_at)
       RETURNING id::text`,
      [bodies, receivedAts],
    );

    if (result.rows.length !== envelopes.length) {
      throw new Error(
        `[spool] batch INSERT returned ${result.rows.length} rows for ${envelopes.length} envelopes`,
      );
    }
    return result.rows.map((row) => BigInt(row.id));
  }

  /**
   * Claim up to `limit` pending rows inside a transaction held on a dedicated pool client
   * (AUD-PERF-006). FOR UPDATE SKIP LOCKED makes concurrent claimers — an overlapping tick or a
   * second collector replica — skip already-claimed rows instead of double-producing them; the
   * standard PG queue pattern. No schema change: the row lock IS the claim (status stays
   * 'pending' until markDrained + commit), and a crash releases it server-side automatically.
   */
  async claimPending(limit: number): Promise<SpoolClaim> {
    const client = await this.pool.connect();
    let settled = false;
    const settle = async (verb: 'COMMIT' | 'ROLLBACK'): Promise<void> => {
      if (settled) return;
      settled = true;
      try {
        await client.query(verb);
      } finally {
        client.release();
      }
    };

    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string; raw_body: Record<string, unknown> }>(
        `SELECT id::text, raw_body
         FROM collector_spool
         WHERE status = 'pending'
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit],
      );

      const entries: PendingSpoolEntry[] = result.rows.map((row) => ({
        id: BigInt(row.id),
        rawBody: row.raw_body,
      }));

      return {
        entries,
        markDrained: async (ids: bigint[]): Promise<void> => {
          if (ids.length === 0) return;
          await client.query(
            `UPDATE collector_spool
             SET status = 'drained', drained_at = now()
             WHERE id = ANY($1::bigint[])`,
            [ids.map((id) => id.toString())],
          );
        },
        commit: () => settle('COMMIT'),
        rollback: () => settle('ROLLBACK'),
      };
    } catch (err) {
      // BEGIN/SELECT failed — release the client (rollback is best-effort on a broken conn).
      await settle('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  async countPendingBounded(cap: number): Promise<number> {
    // Bounded count: the inner LIMIT lets Postgres stop after `cap` index entries, so this
    // stays O(cap) on idx_collector_spool_pending (the partial index) regardless of how many
    // drained rows the table holds. We never need the exact depth — only its position
    // relative to the high/low-water marks (C4 / R-09).
    const result = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM (SELECT 1 FROM collector_spool WHERE status = 'pending' LIMIT $1) AS bounded`,
      [cap],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  async reapDrained(olderThanSeconds: number): Promise<number> {
    // DELETE only already-drained rows past the trail window; bounded scan via
    // idx_collector_spool_drained (partial WHERE status='drained'). Disposable once produced.
    const result = await this.pool.query<{ n: string }>(
      `WITH del AS (
         DELETE FROM collector_spool
          WHERE status = 'drained'
            AND drained_at < now() - make_interval(secs => $1)
         RETURNING 1
       )
       SELECT count(*)::text AS n FROM del`,
      [olderThanSeconds],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (err) {
      // Spool DB unreachable — return false so /readyz reports not_ready (the false IS the signal),
      // but surface the cause in the structured log instead of swallowing it (degraded, recoverable).
      log.warn('spool DB ping failed — readiness will report unreachable', { err });
      return false;
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
