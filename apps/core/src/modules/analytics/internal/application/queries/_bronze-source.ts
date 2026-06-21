/**
 * _bronze-source.ts — shared helper for the operational-read Bronze source flip (ADR-0002 Slice 5).
 *
 * Operational reads (data/tracking health, recent events, orders) read raw Bronze events. The flag
 * BRONZE_OPERATIONAL_READ_SOURCE selects the source: 'pg' (bronze_events, default) or 'iceberg'
 * (collector_events in the StarRocks external Iceberg catalog). The Iceberg path goes through the
 * metric-engine withSilverBrand seam, which injects the tenant predicate at ${BRAND_PREDICATE} — so
 * a query cannot omit brand isolation (the SAME mechanism the Silver reads use; verified non-inert by
 * the isolation-fuzz mutation test).
 */

import type { EngineDeps, SilverPool } from '@brain/metric-engine';

/** Bronze source for operational reads. */
export type BronzeSource = 'pg' | 'iceberg';

/** Deps for an operational read that can source Bronze from PG or Iceberg. */
export interface BronzeReadDeps extends EngineDeps {
  /** StarRocks pool — required only when bronzeSource is 'iceberg'. */
  readonly srPool?: SilverPool;
  /** 'pg' (default) | 'iceberg'. */
  readonly bronzeSource?: BronzeSource;
}

/**
 * The fully-qualified Iceberg Bronze table in the StarRocks external catalog
 * (db/starrocks/external_iceberg_catalog.sql). Catalog name is env-overridable so prod can point at
 * the Glue catalog (brain_bronze_prod) without code change.
 */
export const ICEBERG_BRONZE = `${process.env['STARROCKS_BRONZE_CATALOG'] ?? 'brain_bronze_local'}.brain_bronze.collector_events`;

/** True when the read should use the Iceberg path (flag set + srPool wired). */
export function useIceberg(deps: BronzeReadDeps): deps is BronzeReadDeps & { srPool: SilverPool } {
  return deps.bronzeSource === 'iceberg' && deps.srPool != null;
}
