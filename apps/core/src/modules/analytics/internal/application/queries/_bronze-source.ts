/**
 * _bronze-source.ts — shared helper for the operational-read Bronze source (ADR-0010).
 *
 * Operational reads (data/tracking health, recent events, orders) read raw Bronze events. Under
 * ADR-0010 the Kafka Connect Iceberg sink is the ONLY Bronze landing writer: the collector lane
 * lands in `iceberg.brain_bronze.collector_events_connect` (truly raw — payload + kafka coords only),
 * and these column-shaped reads go through the Trino LIFT VIEW
 * `iceberg.brain_bronze.collector_events_connect_lifted` (exposes event_id/brand_id/event_type/
 * occurred_at/ingested_at/correlation_id/payload). Bronze is APPEND-ONLY — dedup lives in Silver
 * (silver_collector_event MERGE on brand_id/event_id). Historical rows in the retired
 * brain_bronze.events / collector_events tables still exist as DATA but are NOT served here.
 * The read path goes through the metric-engine withSilverBrand seam, which injects the tenant
 * predicate at ${BRAND_PREDICATE} — so a query cannot omit brand isolation (the SAME mechanism the
 * Silver reads use; verified non-inert by the isolation-fuzz mutation test). When the serving tier
 * isn't wired (srPool absent), the reads return an honest no_data shape.
 */

import type { EngineDeps, SilverPool } from '@brain/metric-engine';

/** Deps for an operational read that sources Bronze from the Iceberg catalog over Trino. */
export interface BronzeReadDeps extends EngineDeps {
  /** Trino serving pool — required to read the Iceberg Bronze namespace. Absent → honest no_data. */
  readonly srPool?: SilverPool;
}

/**
 * The Bronze collector source over Trino (default catalog 'iceberg'): the ADR-0010 lift view over
 * the Kafka Connect collector table. CONSTANT — the legacy BRONZE_SOURCE env switch is REMOVED
 * (connect is the only writer; there is nothing to roll back to).
 */
export const ICEBERG_BRONZE = 'iceberg.brain_bronze.collector_events_connect_lifted';
/**
 * Collector-lane predicate — the lift view is SINGLE-LANE (collector only), so this is a constant
 * no-op `TRUE`. Kept as an export so the callers' `AND ${BRONZE_COLLECTOR_PREDICATE}` SQL shape
 * stays uniform (`WHERE TRUE AND brand_id = ?`).
 */
export const BRONZE_COLLECTOR_PREDICATE = 'TRUE';

/**
 * True when the Trino serving pool is wired (the only Bronze source now). Guards srPool presence so
 * a deployment without the serving tier returns honest no_data instead of erroring.
 */
export function hasSilver(deps: BronzeReadDeps): deps is BronzeReadDeps & { srPool: SilverPool } {
  return deps.srPool != null;
}
