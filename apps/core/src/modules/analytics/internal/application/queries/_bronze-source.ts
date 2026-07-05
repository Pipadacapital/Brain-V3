/**
 * _bronze-source.ts — shared helper for the operational-read Bronze source (ADR-0002 Slice 5).
 *
 * Operational reads (data/tracking health, recent events, orders) read raw Bronze events. The PG
 * bronze_events table has been RETIRED (dropped in db/migrations/0070) — Iceberg is now the SOLE
 * Bronze source: collector_events in the Iceberg Bronze namespace, read over TRINO (Brain V4 —
 * StarRocks removed). The Iceberg path goes through the metric-engine withSilverBrand seam, which
 * injects the tenant predicate at ${BRAND_PREDICATE} — so a query cannot omit brand isolation (the
 * SAME mechanism the Silver reads use; verified non-inert by the isolation-fuzz mutation test). When
 * the serving tier isn't wired (srPool absent), the reads return an honest no_data shape.
 */

import type { EngineDeps, SilverPool } from '@brain/metric-engine';

/** Deps for an operational read that sources Bronze from the Iceberg catalog over Trino. */
export interface BronzeReadDeps extends EngineDeps {
  /** Trino serving pool — required to read the Iceberg Bronze namespace. Absent → honest no_data. */
  readonly srPool?: SilverPool;
}

/**
 * The fully-qualified Iceberg Bronze table over Trino (Brain V4 — StarRocks removed). Trino's default
 * catalog is 'iceberg'.
 *
 * BRONZE_SOURCE switch — ONE env flips this reader:
 *   BRONZE_SOURCE=legacy (default) → iceberg.brain_bronze.collector_events (bronze_materialize.py).
 *   BRONZE_SOURCE=events           → iceberg.brain_bronze.events, filtered to the collector lane
 *                                    (the unified bronze_landing.py Spark-SS sink).
 *   BRONZE_SOURCE=connect          → iceberg.brain_bronze.collector_events_connect_lifted — the
 *                                    Trino lift view over the ADR-0010 Kafka Connect collector
 *                                    table (which is truly-raw: payload + kafka coords only; the
 *                                    view lifts brand_id/event_type/occurred_at/ingested_at so the
 *                                    column-shaped queries here work unchanged).
 * Rollback = set BRONZE_SOURCE back to the previous writer's value.
 */
const BRONZE_SOURCE = (process.env['BRONZE_SOURCE'] ?? 'legacy').toLowerCase();
export const ICEBERG_BRONZE =
  BRONZE_SOURCE === 'events'
    ? 'iceberg.brain_bronze.events'
    : BRONZE_SOURCE === 'connect'
      ? 'iceberg.brain_bronze.collector_events_connect_lifted'
      : 'iceberg.brain_bronze.collector_events';
/**
 * Predicate that keeps ONLY the collector lane when reading the unified events table (which co-locates
 * the raw connector lanes); a no-op (`TRUE`) against the single-lane collector_events /
 * collector_events_connect tables. Append to a Bronze WHERE as `AND ${BRONZE_COLLECTOR_PREDICATE}`.
 */
export const BRONZE_COLLECTOR_PREDICATE = BRONZE_SOURCE === 'events' ? "connector = 'collector'" : 'TRUE';

/**
 * True when the Trino serving pool is wired (the only Bronze source now). Guards srPool presence so
 * a deployment without the serving tier returns honest no_data instead of erroring.
 */
export function hasSilver(deps: BronzeReadDeps): deps is BronzeReadDeps & { srPool: SilverPool } {
  return deps.srPool != null;
}
