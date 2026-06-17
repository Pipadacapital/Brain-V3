/**
 * @brain/metric-engine — computeKpiSummary
 *
 * Returns point-in-time KPI summary for a brand:
 *   - realizedMinor:    gross realized revenue as of asOf (bigint minor units)
 *   - provisionalMinor: provisional revenue as of asOf (bigint minor units)
 *   - orderCount:       COUNT(DISTINCT order_id) across all ledger rows as of asOf
 *   - aovMinor:         realized ÷ orderCount (integer division, minor units)
 *   - rtoRatePct:       rto_reversal distinct orders / total distinct orders × 100
 *
 * All computations live here — the sole sanctioned computation layer (ADR-002 / D-3).
 * F-SEC-02: reads inside withBrandTxn (GUC transaction-scoped, RLS-enforced).
 */

import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

export interface KpiSummaryResult {
  /** ISO 4217 currency code */
  currency_code: string;
  /** Gross realized revenue minor units (bigint) */
  realizedMinor: bigint;
  /** Provisional revenue minor units (bigint) */
  provisionalMinor: bigint;
  /** Distinct order count */
  orderCount: bigint;
  /** Average order value in minor units (integer division) */
  aovMinor: bigint;
  /** RTO rate 0–100 (as a float percentage, 2 decimal places via string) */
  rtoRatePct: string;
}

/**
 * computeKpiSummary — brand KPI snapshot as of a date.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param asOf    - Inclusive as-of date.
 * @param deps    - EngineDeps with raw pg.Pool.
 * @returns       Array of KpiSummaryResult per currency (M1: 1 entry).
 *                Empty array when no ledger rows exist.
 */
export async function computeKpiSummary(
  brandId: string,
  asOf: Date,
  deps: EngineDeps,
): Promise<KpiSummaryResult[]> {
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
        SELECT DISTINCT order_id
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
      provisional AS (
        SELECT
          currency_code,
          SUM(amount_minor) AS provisional_minor
        FROM realized_revenue_ledger
        WHERE brand_id = $1
          AND event_type = 'provisional_recognition'
          AND recognition_label IN ('provisional', 'settling')
          AND occurred_at::date <= $2::date
        GROUP BY currency_code
      ),
      order_counts AS (
        SELECT
          currency_code,
          COUNT(*) AS order_count,
          (SELECT COUNT(*) FROM rto_orders) AS rto_count
        FROM all_orders
        GROUP BY currency_code
      )
      SELECT
        oc.currency_code,
        COALESCE(r.realized_minor, 0)::text AS realized_minor,
        COALESCE(p.provisional_minor, 0)::text AS provisional_minor,
        oc.order_count::text,
        oc.rto_count::text,
        CASE WHEN oc.order_count > 0
             THEN ROUND(oc.rto_count::numeric / oc.order_count * 100, 2)::text
             ELSE '0'
        END AS rto_rate_pct
      FROM order_counts oc
      LEFT JOIN realized r ON r.currency_code = oc.currency_code
      LEFT JOIN provisional p ON p.currency_code = oc.currency_code
      ORDER BY oc.currency_code
    `;

    const result = await client.query<{
      currency_code: string;
      realized_minor: string;
      provisional_minor: string;
      order_count: string;
      rto_count: string;
      rto_rate_pct: string;
    }>(sql, [brandId, asOfStr]);

    return result.rows.map((row) => {
      const orderCount = BigInt(row.order_count);
      const realizedMinor = BigInt(row.realized_minor);
      const aovMinor = orderCount > 0n ? realizedMinor / orderCount : 0n;
      return {
        currency_code: row.currency_code,
        realizedMinor,
        provisionalMinor: BigInt(row.provisional_minor),
        orderCount,
        aovMinor,
        rtoRatePct: row.rto_rate_pct,
      };
    });
  });
}
