/**
 * _bronze-source.ts — shared helper for the operational-read Bronze source (ADR-0002 Slice 5).
 *
 * Operational reads (data/tracking health, recent events, orders) read raw Bronze events. The PG
 * bronze_events table has been RETIRED (dropped in db/migrations/0070) — Iceberg is now the SOLE
 * Bronze source: collector_events in the StarRocks external Iceberg catalog. The Iceberg path goes
 * through the metric-engine withSilverBrand seam, which injects the tenant predicate at
 * ${BRAND_PREDICATE} — so a query cannot omit brand isolation (the SAME mechanism the Silver reads
 * use; verified non-inert by the isolation-fuzz mutation test). When StarRocks isn't wired (srPool
 * absent), the reads return an honest no_data shape rather than ever falling back to PG.
 */

import type { EngineDeps, SilverPool } from '@brain/metric-engine';

/** Deps for an operational read that sources Bronze from the Iceberg catalog. */
export interface BronzeReadDeps extends EngineDeps {
  /** StarRocks pool — required to read the Iceberg Bronze catalog. Absent → honest no_data. */
  readonly srPool?: SilverPool;
}

/**
 * The fully-qualified Iceberg Bronze table in the StarRocks external catalog
 * (db/starrocks/external_iceberg_catalog.sql). Catalog name is env-overridable so prod can point at
 * the Glue catalog (brain_bronze_prod) without code change.
 */
// intentional: module-load constant. STARROCKS_BRONZE_CATALOG exists in @brain/config, but
// loadCoreConfig() at module-load validates the full schema + process.exit(1)s on missing env →
// would crash standalone unit imports. Left raw to preserve zero import-time behaviour change.
export const ICEBERG_BRONZE = `${process.env['STARROCKS_BRONZE_CATALOG'] ?? 'brain_bronze_local'}.brain_bronze.collector_events`;

/**
 * True when the StarRocks pool is wired (the only Bronze source now). Guards srPool presence so a
 * deployment without StarRocks returns honest no_data instead of erroring.
 */
export function hasSilver(deps: BronzeReadDeps): deps is BronzeReadDeps & { srPool: SilverPool } {
  return deps.srPool != null;
}
