/**
 * SPEC: B.2 (WB-B2) — PgJourneyReversionDirtyRepository: the concrete PostgreSQL adapter for the
 * IJourneyReversionDirtyRepository port.
 *
 * Writes to ops.journey_reversion_pending (PG `ops` schema — migration 0125). Idempotency is an explicit
 *   INSERT ... ON CONFLICT (brand_id, brain_id) DO UPDATE
 * — re-delivering the same identity mutation yields the same dirty brain_ids, so a retry refreshes the
 * row's provenance (cause / trigger_event / source_event_id / enqueued_at) without creating a duplicate.
 * Mirrors PgRestitchDirtyRepository's conflict-clause upsert, at brain grain instead of key grain.
 *
 * TENANT ISOLATION: brand_id is the PRIMARY KEY lead column of ops.journey_reversion_pending. Like
 * ops.restitch_pending / ops.scoped_recompute_request this is a cross-brand trusted-ETL queue (the worker
 * runs as brain_app with NO brand GUC; the Spark drain reads all flag-ON brands), so the table is NOT
 * RLS-forced; isolation is the explicit brand_id on every row.
 *
 * MONEY: none. Only brand/brain UUIDs, an enum cause, and timestamps.
 *
 * DDL: db/migrations/0125_journey_reversion_pending.sql.
 */
import type pg from 'pg';
import type {
  JourneyDirtyEntry,
  IJourneyReversionDirtyRepository,
} from '../../domain/journey/JourneyReversionDirty.js';

export class PgJourneyReversionDirtyRepository implements IJourneyReversionDirtyRepository {
  /**
   * @param pool  pg.Pool connected to PostgreSQL as brain_app (the worker's dbUrl pool).
   */
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Idempotent batch upsert into ops.journey_reversion_pending. Uses UNNEST so the whole entry batch for
   * one mutation is a SINGLE round-trip (a merge/unmerge dirties two brains, a link dirties one). ON
   * CONFLICT (brand_id, brain_id) DO UPDATE — safe to re-run on consumer retry with identical keys. When a
   * brain is re-dirtied before the drain (e.g. a merge then a later restitch), the latest cause/provenance
   * wins; the Spark reversion job re-derives the authoritative cause from its own detection either way, so
   * a single N+1 rebuild covers both.
   */
  async markDirty(entries: JourneyDirtyEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const brandIds = entries.map((e) => e.brand_id);
    const brainIds = entries.map((e) => e.brain_id);
    const causes = entries.map((e) => e.cause);
    const triggers = entries.map((e) => e.trigger_event);
    const sourceIds = entries.map((e) => e.source_event_id);
    await this.pool.query(
      `INSERT INTO ops.journey_reversion_pending
         (brand_id, brain_id, cause, trigger_event, source_event_id, enqueued_at)
       SELECT b::uuid, br::uuid, c, t, s, now()
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
         AS u(b, br, c, t, s)
       ON CONFLICT (brand_id, brain_id) DO UPDATE SET
         cause           = EXCLUDED.cause,
         trigger_event   = EXCLUDED.trigger_event,
         source_event_id = EXCLUDED.source_event_id,
         enqueued_at     = EXCLUDED.enqueued_at`,
      [brandIds, brainIds, causes, triggers, sourceIds],
    );
  }
}
