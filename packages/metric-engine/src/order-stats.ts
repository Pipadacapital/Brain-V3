/**
 * @brain/metric-engine — computeOrderStats
 *
 * Returns point-in-time per-currency order statistics for a brand as of a date:
 *   - orderCount:  COUNT(DISTINCT order_id) across all ledger rows as of asOf
 *   - aovMinor:    realized ÷ orderCount (integer division, minor units)
 *   - rtoRatePct:  rto_reversal distinct orders / total distinct orders × 100 (numeric string)
 *
 * All computations live here — the sole sanctioned computation layer (ADR-002 / D-3).
 * F-SEC-02: reads inside withBrandTxn (GUC transaction-scoped, RLS-enforced).
 */

import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

export interface OrderStatsResult {
  /** ISO 4217 currency code */
  currency_code: string;
  /** Distinct order count (bigint) */
  orderCount: bigint;
  /** Average order value in minor units (integer division, bigint) */
  aovMinor: bigint;
  /** RTO rate 0–100 (numeric string, 2 decimal places) */
  rtoRatePct: string;
}

/**
 * computeOrderStats — per-currency order stats snapshot as of a date.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param asOf    - Inclusive as-of date.
 * @param deps    - EngineDeps with raw pg.Pool.
 * @returns       Array of OrderStatsResult per currency (M1: 1 entry).
 *                Empty array when no ledger rows exist.
 */
export async function computeOrderStats(
  brandId: string,
  asOf: Date,
  deps: EngineDeps,
): Promise<OrderStatsResult[]> {
  const asOfStr = asOf.toISOString().split('T')[0];

  return withBrandTxn(deps.pool, brandId, async (client) => {
    const sql = `
      WITH all_orders AS (
        SELECT DISTINCT order_id, currency_code
        FROM realized_revenue_ledger
        WHERE brand_id = $1
          AND occurred_at::date <= $2::date
      ),
      rto_orders AS (
        SELECT DISTINCT order_id, currency_code
        FROM realized_revenue_ledger
        WHERE brand_id = $1
          AND event_type = 'rto_reversal'
          AND occurred_at::date <= $2::date
      ),
      realized AS (
        SELECT
          currency_code,
          SUM(amount_minor) AS realized_minor
        FROM realized_revenue_ledger
        WHERE brand_id = $1
          AND event_type IN ('finalization', 'rto_reversal')
          AND occurred_at::date <= $2::date
        GROUP BY currency_code
      ),
      order_counts AS (
        SELECT currency_code, COUNT(*) AS order_count
        FROM all_orders
        GROUP BY currency_code
      ),
      rto_counts AS (
        SELECT currency_code, COUNT(*) AS rto_count
        FROM rto_orders
        GROUP BY currency_code
      )
      SELECT
        oc.currency_code,
        oc.order_count::text AS order_count,
        COALESCE(r.realized_minor, 0)::text AS realized_minor,
        CASE WHEN oc.order_count > 0
             THEN ROUND(COALESCE(rc.rto_count, 0)::numeric / oc.order_count * 100, 2)::text
             ELSE '0'
        END AS rto_rate_pct
      FROM order_counts oc
      LEFT JOIN realized r ON r.currency_code = oc.currency_code
      LEFT JOIN rto_counts rc ON rc.currency_code = oc.currency_code
      ORDER BY oc.currency_code
    `;

    const result = await client.query<{
      currency_code: string;
      order_count: string;
      realized_minor: string;
      rto_rate_pct: string;
    }>(sql, [brandId, asOfStr]);

    return result.rows.map((row) => {
      const orderCount = BigInt(row.order_count);
      const realizedMinor = BigInt(row.realized_minor);
      const aovMinor = orderCount > 0n ? realizedMinor / orderCount : 0n;
      return {
        currency_code: row.currency_code,
        orderCount,
        aovMinor,
        rtoRatePct: row.rto_rate_pct,
      };
    });
  });
}
