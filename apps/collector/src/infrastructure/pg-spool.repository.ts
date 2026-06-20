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
import type { SpoolRepository } from '../domain/ingest/repositories/spool.repository.js';
import type { IngestEnvelope } from '../domain/ingest/value-objects/envelope.js';
import type { PendingSpoolEntry } from '../domain/ingest/entities/spool-entry.js';

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

  async pollPending(limit: number): Promise<PendingSpoolEntry[]> {
    const result = await this.pool.query<{ id: string; raw_body: Record<string, unknown> }>(
      `SELECT id::text, raw_body
       FROM collector_spool
       WHERE status = 'pending'
       ORDER BY id
       LIMIT $1`,
      [limit],
    );

    return result.rows.map((row) => ({
      id: BigInt(row.id),
      rawBody: row.raw_body,
    }));
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

  async markDrained(id: bigint): Promise<void> {
    await this.pool.query(
      `UPDATE collector_spool
       SET status = 'drained', drained_at = now()
       WHERE id = $1`,
      [id.toString()],
    );
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
