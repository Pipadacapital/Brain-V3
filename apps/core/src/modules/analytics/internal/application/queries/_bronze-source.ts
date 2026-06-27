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
 * The fully-qualified Iceberg Bronze table over Trino (Brain V4 — StarRocks removed). Trino's
 * default catalog is 'iceberg', so the explicit `iceberg.brain_bronze.collector_events` resolves the
 * Iceberg Bronze namespace directly (mirrors stream-worker dq/silver-reader.ts ICEBERG_BRONZE).
 */
export const ICEBERG_BRONZE = 'iceberg.brain_bronze.collector_events';

/**
 * True when the Trino serving pool is wired (the only Bronze source now). Guards srPool presence so
 * a deployment without the serving tier returns honest no_data instead of erroring.
 */
export function hasSilver(deps: BronzeReadDeps): deps is BronzeReadDeps & { srPool: SilverPool } {
  return deps.srPool != null;
}
