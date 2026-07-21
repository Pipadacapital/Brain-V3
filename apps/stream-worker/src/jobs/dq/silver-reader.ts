/**
 * dq/silver-reader.ts — minimal per-brand Silver/Gold serving reader for the DQ jobs.
 *
 * Brain V4 (Trino removed, ADR-0014): the DQ freshness + reconciliation checks read aggregate
 * signals from the serving tier over duckdb-serving (brain_serving.mv_silver_order_state — a
 * replica-local DuckDB view over Iceberg Silver) via the serving HTTP adapter. This mirrors the
 * metric-engine withSilverBrand seam (packages/metric-engine/src/silver-deps.ts): the brand
 * predicate is injected HERE (the serving API has no engine row-policy), so a DQ check is always
 * brand-scoped — never cross-brand.
 *
 * NOT a new deployable / topic / envelope — a library helper used by the DQ
 * interval loops inside the existing stream-worker process.
 */

import { createDuckDbServingPool } from '@brain/metric-engine';

export interface SilverReaderConfig {
  /** duckdb-serving base URL, e.g. 'http://localhost:8091'. */
  readonly baseUrl: string;
  /**
   * Optional server-side statement budget (ms), sent per-request as `timeout_ms` (the serving
   * engine clamps it to its STATEMENT_TIMEOUT_MAX_MS cap). Batch lanes (silver-identity's
   * keystone reads — ~700-file day-partition floor, >25s by file-count alone) raise this above
   * the adapter's 25s OLTP default; the client fetch abort is derived to exceed it by 10s so
   * the server watchdog always fires first (clean 504, not an opaque fetch abort).
   */
  readonly queryTimeoutMs?: number;
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
 * The Iceberg Bronze collector source over duckdb-serving. DB-AUDIT C4: the DQ checks read Bronze
 * from the lakehouse (the Bronze SoR), NOT the retired PG data_plane.bronze_events. Under ADR-0010
 * the Kafka Connect Iceberg sink is the ONLY Bronze writer — this is the LIFT VIEW over the
 * truly-raw collector_events_connect table (the view lifts the envelope scalars these DQ checks
 * select). TWO-PART name: the lift view lives in the replica-LOCAL brain_bronze schema (which
 * shadows the catalog namespace — spike gate d); a 3-part iceberg.* name would bypass it and hit
 * the raw (unlifted) catalog table. CONSTANT — the legacy BRONZE_SOURCE env switch is REMOVED
 * (mirrors analytics _bronze-source.ts).
 */
export const ICEBERG_BRONZE = 'brain_bronze.collector_events_connect_lifted';
/** Collector-lane predicate — the lift view is SINGLE-LANE, so this is a constant no-op `TRUE`.
 * Kept exported so callers' `AND ${BRONZE_COLLECTOR_PREDICATE}` SQL shape stays uniform. */
export const BRONZE_COLLECTOR_PREDICATE = 'TRUE';

export function createSilverReader(config: SilverReaderConfig): SilverReader {
  // duckdb-serving HTTP adapter — the replica applies the brain_serving/brain_bronze views into
  // LOCAL schemas at startup, so the two-part `brain_serving.mv_*` names resolve to the serving
  // views over Iceberg Silver. Stateless REST (no connection pool).
  const pool = createDuckDbServingPool({
    baseUrl: config.baseUrl,
    ...(config.queryTimeoutMs !== undefined && {
      queryTimeoutMs: config.queryTimeoutMs,
      // Client abort must outlive the server watchdog (server 504s first — never an opaque abort).
      fetchTimeoutMs: config.queryTimeoutMs + 10_000,
    }),
  });

  return {
    async scopedQuery<T = Record<string, unknown>>(
      brandId: string,
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      // DB-AUDIT M1 — fail CLOSED: a query missing the sentinel would run cross-brand (String.replace
      // no-ops). Refuse rather than leak. The serving API has no session-var row policy — the
      // parameterized brand predicate injected HERE IS the load-bearing isolation (same as the
      // metric-engine seam).
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
      // Stateless serving HTTP adapter — no connection pool to tear down.
    },
  };
}
