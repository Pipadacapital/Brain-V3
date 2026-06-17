/**
 * @brain/metric-engine — computeOrdersTimeseries
 *
 * Returns per-bucket order metrics for charting:
 *   - orderCount:    COUNT(DISTINCT order_id) with any ledger activity in the bucket
 *   - rtoCount:      COUNT(DISTINCT order_id) with an rto_reversal event in the bucket
 *   - realizedMinor: SUM(amount_minor) of realized rows (finalization + rto_reversal)
 *
 * The metric engine is the SOLE sanctioned computation layer (ADR-002 / D-3).
 * No ad-hoc SUM/COUNT(amount_minor) lives outside this package.
 *
 * Buckets are date_trunc(grain, occurred_at) — charting WHEN events were recorded.
 * Returns one row per distinct (bucket, currency_code) inside the date window.
 * Buckets with zero activity in one dimension carry 0n (not null).
 *
 * F-SEC-02: all reads happen inside withBrandTxn so the GUC is transaction-scoped.
 * RLS policy (brand_id = current_setting(...)) scopes rows to the active brand.
 */

import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';
import type { TimeGrain } from './revenue-timeseries.js';

export interface OrdersTimeseriesBucket {
  /** ISO date string of the bucket start: 'YYYY-MM-DD' */
  bucket: string;
  /** ISO 4217 currency code */
  currency_code: string;
  /** Distinct order count active in this bucket (bigint) */
  orderCount: bigint;
  /** Distinct RTO (rto_reversal) order count in this bucket (bigint) */
  rtoCount: bigint;
  /** Realized revenue minor units for this bucket (finalization + rto_reversal net) */
  realizedMinor: bigint;
}

/**
 * computeOrdersTimeseries — per-bucket order count + RTO count + realized revenue.
 *
 * @param brandId  - Brand UUID (from session — D-1).
 * @param params   - Date window + grain.
 * @param deps     - EngineDeps with raw pg.Pool.
 * @returns        Array of OrdersTimeseriesBucket, ordered by bucket ASC.
 *                 Empty array when no ledger rows exist in the window.
 */
export async function computeOrdersTimeseries(
  brandId: string,
  params: { fromDate: Date; toDate: Date; grain: TimeGrain },
  deps: EngineDeps,
): Promise<OrdersTimeseriesBucket[]> {
  const fromStr = params.fromDate.toISOString().split('T')[0];
  const toStr = params.toDate.toISOString().split('T')[0];
  const grain = params.grain; // 'day' | 'week' — safe constant, not user-interpolated

  return withBrandTxn(deps.pool, brandId, async (client) => {
    // orders CTE  — distinct orders active per (bucket, currency) + realized sum.
    //   realized_minor = SUM over finalization + rto_reversal rows only (net realized).
    //   order_count    = COUNT(DISTINCT order_id) across ALL event types (any activity).
    // rto CTE     — distinct orders with an rto_reversal event per (bucket, currency).
    //
    // date_trunc requires a literal first arg; we translate via CASE on $3::text
    // (a TypeScript-controlled 'day'|'week' constant — never user-interpolated SQL).
    const sql = `
      WITH orders AS (
        SELECT
          date_trunc(
            CASE $3::text WHEN 'week' THEN 'week' ELSE 'day' END,
            occurred_at
          )::date AS bucket,
          currency_code,
          COUNT(DISTINCT order_id) AS order_count,
          COALESCE(SUM(amount_minor) FILTER (
            WHERE event_type IN ('finalization', 'rto_reversal')
          ), 0) AS realized_minor
        FROM realized_revenue_ledger
        WHERE brand_id = $1
          AND occurred_at::date BETWEEN $2::date AND $4::date
        GROUP BY 1, 2
      ),
      rto AS (
        SELECT
          date_trunc(
            CASE $3::text WHEN 'week' THEN 'week' ELSE 'day' END,
            occurred_at
          )::date AS bucket,
          currency_code,
          COUNT(DISTINCT order_id) AS rto_count
        FROM realized_revenue_ledger
        WHERE brand_id = $1
          AND event_type = 'rto_reversal'
          AND occurred_at::date BETWEEN $2::date AND $4::date
        GROUP BY 1, 2
      )
      SELECT
        o.bucket,
        o.currency_code,
        o.order_count::text AS order_count,
        COALESCE(r.rto_count, 0)::text AS rto_count,
        o.realized_minor::text AS realized_minor
      FROM orders o
      LEFT JOIN rto r ON r.bucket = o.bucket AND r.currency_code = o.currency_code
      ORDER BY o.bucket ASC, o.currency_code ASC
    `;

    const result = await client.query<{
      bucket: Date;
      currency_code: string;
      order_count: string;
      rto_count: string;
      realized_minor: string;
    }>(sql, [brandId, fromStr, grain, toStr]);

    return result.rows.map((row) => ({
      bucket: row.bucket.toISOString().split('T')[0] as string,
      currency_code: row.currency_code,
      orderCount: BigInt(row.order_count),
      rtoCount: BigInt(row.rto_count),
      realizedMinor: BigInt(row.realized_minor),
    }));
  });
}
