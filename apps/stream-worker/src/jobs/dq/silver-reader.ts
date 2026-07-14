/**
 * dq/silver-reader.ts — minimal per-brand Silver/Gold serving reader for the DQ jobs.
 *
 * Brain V4 (StarRocks removed): the DQ freshness + reconciliation checks read aggregate signals
 * from the serving tier over TRINO (brain_serving.mv_silver_order_state — a Trino view over Iceberg
 * Silver) via the Trino HTTP adapter. This mirrors the metric-engine withSilverBrand seam
 * (packages/metric-engine/src/silver-deps.ts): the brand predicate is injected HERE (Trino's REST
 * API has no engine row-policy), so a DQ check is always brand-scoped — never cross-brand.
 *
 * NOT a new deployable / topic / envelope — a library helper used by the DQ
 * interval loops inside the existing stream-worker process.
 */

import { createTrinoPool } from '@brain/metric-engine';

export interface SilverReaderConfig {
  /** Trino coordinator base URL, e.g. 'http://localhost:8090'. */
  readonly baseUrl: string;
  /** Trino user presented via X-Trino-User (not authentication). */
  readonly user: string;
}

export interface SilverReader {
  /**
   * Run a brand-scoped aggregate SELECT against Silver. The caller's SQL ends its
   * WHERE with the literal token ${BRAND_PREDICATE}; this helper substitutes the
   * parameterized `brand_id = ?` and appends the brandId param (the seam injects
   * the predicate, the caller cannot forget it).
   */
  scopedQuery<T = Record<string, unknown>>(
    brandId: string,
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  end(): Promise<void>;
}

export const BRAND_PREDICATE = '${BRAND_PREDICATE}';

/**
 * The Iceberg Bronze collector source over Trino. DB-AUDIT C4: the DQ checks read Bronze from the
 * lakehouse (the Bronze SoR), NOT the retired PG data_plane.bronze_events. Under ADR-0010 the Kafka
 * Connect Iceberg sink is the ONLY Bronze writer — this is the Trino LIFT VIEW over the truly-raw
 * collector_events_connect table (the view lifts the envelope scalars these DQ checks select).
 * CONSTANT — the legacy BRONZE_SOURCE env switch is REMOVED (mirrors analytics _bronze-source.ts).
 */
export const ICEBERG_BRONZE = 'iceberg.brain_bronze.collector_events_connect_lifted';
/** Collector-lane predicate — the lift view is SINGLE-LANE, so this is a constant no-op `TRUE`.
 * Kept exported so callers' `AND ${BRONZE_COLLECTOR_PREDICATE}` SQL shape stays uniform. */
export const BRONZE_COLLECTOR_PREDICATE = 'TRUE';

export function createSilverReader(config: SilverReaderConfig): SilverReader {
  // Trino HTTP adapter — catalog='iceberg', schema='brain_serving' so two-part `brain_serving.mv_*`
  // names resolve to the Trino serving views over Iceberg Silver. Stateless REST (no connection pool).
  const pool = createTrinoPool({
    baseUrl: config.baseUrl,
    catalog: 'iceberg',
    schema: 'brain_serving',
    user: config.user,
  });

  return {
    async scopedQuery<T = Record<string, unknown>>(
      brandId: string,
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      // DB-AUDIT M1 — fail CLOSED: a query missing the sentinel would run cross-brand (String.replace
      // no-ops). Refuse rather than leak. Trino has no session-var row policy — the parameterized
      // brand predicate injected HERE IS the load-bearing isolation (same as the metric-engine seam).
      if (!sql.includes(BRAND_PREDICATE)) {
        throw new Error(
          'SilverReader.scopedQuery: query missing the ${BRAND_PREDICATE} sentinel — refusing to run un-scoped.',
        );
      }
      const finalSql = sql.replace(BRAND_PREDICATE, 'brand_id = ?');
      const finalParams = [...params, brandId];
      return pool.query<T>(finalSql, finalParams);
    },
    async end(): Promise<void> {
      // Stateless Trino HTTP adapter — no connection pool to tear down.
    },
  };
}
