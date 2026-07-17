/**
 * SPEC: A.2.3.5 (WA-18) — PgRestitchDirtyRepository: the concrete PostgreSQL adapter for the
 * IRestitchDirtyRepository port.
 *
 * Writes to ops.restitch_pending (PG `ops` schema — migration 0124). Idempotency is an explicit
 *   INSERT ... ON CONFLICT (brand_id, dirty_kind, dirty_key) DO UPDATE
 * — re-delivering the same identity mutation yields the same dirty keys, so a retry refreshes the row's
 * provenance (trigger_event / source_event_id / enqueued_at) without creating a duplicate. Mirrors
 * PgScopedRecomputeRepository's conflict-clause upsert.
 *
 * TENANT ISOLATION: brand_id is the PRIMARY KEY lead column of ops.restitch_pending. Like
 * ops.scoped_recompute_request this is a cross-brand trusted-ETL queue (the worker runs as brain_app with
 * NO brand GUC), so the table is NOT RLS-forced; isolation is the explicit brand_id on every row.
 *
 * MONEY: none. Only opaque hashes/UUIDs + timestamps.
 *
 * DDL: db/migrations/0124_restitch_pending.sql.
 */
import type pg from 'pg';
import type {
  RestitchDirtyEntry,
  IRestitchDirtyRepository,
} from '../../domain/identity/RestitchDirty.js';

export class PgRestitchDirtyRepository implements IRestitchDirtyRepository {
  /**
   * @param pool  pg.Pool connected to PostgreSQL as brain_app (the worker's dbUrl pool).
   */
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Idempotent batch upsert into ops.restitch_pending. Uses UNNEST so the whole entry batch for one
   * mutation is a SINGLE round-trip (a mint/link/merge dirties a small handful of keys). ON CONFLICT
   * (brand_id, dirty_kind, dirty_key) DO UPDATE — safe to re-run on consumer retry with identical keys.
   */
  async markDirty(entries: RestitchDirtyEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const brandIds = entries.map((e) => e.brand_id);
    const kinds = entries.map((e) => e.dirty_kind);
    const keys = entries.map((e) => e.dirty_key);
    const triggers = entries.map((e) => e.trigger_event);
    const sourceIds = entries.map((e) => e.source_event_id);
    await this.pool.query(
      `INSERT INTO ops.restitch_pending
         (brand_id, dirty_kind, dirty_key, trigger_event, source_event_id, enqueued_at)
       SELECT b::uuid, k, key, t, s, now()
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
         AS u(b, k, key, t, s)
       ON CONFLICT (brand_id, dirty_kind, dirty_key) DO UPDATE SET
         trigger_event   = EXCLUDED.trigger_event,
         source_event_id = EXCLUDED.source_event_id,
         enqueued_at     = EXCLUDED.enqueued_at`,
      [brandIds, kinds, keys, triggers, sourceIds],
    );
  }
}
