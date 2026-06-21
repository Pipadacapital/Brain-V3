/**
 * dq/silver-reader.ts — minimal per-brand Silver (StarRocks) reader for the DQ jobs.
 *
 * The DQ freshness + reconciliation checks read aggregate signals from the Silver
 * tier (StarRocks brain_silver.silver_order_state) over the MySQL wire protocol
 * (mysql2, :9030) as the SELECT-only brain_analytics user. This mirrors the
 * metric-engine withSilverBrand seam (packages/metric-engine/src/silver-deps.ts):
 * the brand predicate is injected HERE (the dev allin1 StarRocks image has no
 * engine row-policy), so a DQ check is always brand-scoped — never cross-brand.
 *
 * NOT a new deployable / topic / envelope — a library helper used by the DQ
 * interval loops inside the existing stream-worker process.
 */

import mysql from 'mysql2/promise';

export interface SilverReaderConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
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

export function createSilverReader(config: SilverReaderConfig): SilverReader {
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    connectionLimit: 3,
    connectTimeout: 5000,
    // StarRocks DATETIMEs are UTC; tell mysql2 so it builds JS Dates as UTC (not the worker's local
    // tz). Without this, a non-UTC worker mis-reads silver MAX(updated_at) as hours-stale → false
    // freshness/silver.order_state D (the DQ "silver freshness" gate).
    timezone: 'Z',
  });

  return {
    async scopedQuery<T = Record<string, unknown>>(
      brandId: string,
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      const conn = await pool.getConnection();
      try {
        // Session var matches the prod row_policy_template convention (drop-in swap on
        // managed StarRocks). Strip to UUID chars (defense-in-depth; brandId is a
        // server-trusted UUID from list_active_brand_ids()).
        const safeBrand = brandId.replace(/[^0-9a-fA-F-]/g, '');
        await conn.query(`SET @brain_current_brand_id = '${safeBrand}'`);
        const finalSql = sql.replace(BRAND_PREDICATE, 'brand_id = ?');
        const finalParams = [...params, brandId];
        const [rows] = await conn.query(finalSql, finalParams);
        return (rows as T[]) ?? [];
      } finally {
        conn.release();
      }
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}
