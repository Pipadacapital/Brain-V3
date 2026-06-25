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

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

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
  deps: { srPool: SilverPool },
): Promise<OrderStatsResult[]> {
  const asOfStr = asOf.toISOString().split('T')[0] as string;

  // MEDALLION REALIGNMENT (Epic 1): read brain_gold.gold_revenue_ledger via withSilverBrand, not PG.
  // Realized = non-provisional (canonical, COD-inclusive); RTO = rto_reversal + cod_rto_clawback.
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      currency_code: string;
      order_count: string | number;
      realized_minor: string | number;
      rto_count: string | number;
    }>(
      `SELECT
         currency_code,
         COUNT(DISTINCT order_id) AS order_count,
         SUM(CASE WHEN event_type <> 'provisional_recognition' THEN amount_minor ELSE 0 END) AS realized_minor,
         COUNT(DISTINCT CASE WHEN event_type IN ('rto_reversal', 'cod_rto_clawback') THEN order_id END) AS rto_count
       FROM brain_serving.mv_gold_revenue_ledger
       WHERE CAST(occurred_at AS DATE) <= ?
         AND ${BRAND_PREDICATE}
       GROUP BY currency_code
       ORDER BY currency_code`,
      [asOfStr],
    );

    return rows.map((row) => {
      const orderCount = BigInt(String(row.order_count ?? '0').split('.')[0] || '0');
      const realizedMinor = BigInt(String(row.realized_minor ?? '0').split('.')[0] || '0');
      const rtoCount = BigInt(String(row.rto_count ?? '0').split('.')[0] || '0');
      const aovMinor = orderCount > 0n ? realizedMinor / orderCount : 0n;
      const rtoRatePct =
        orderCount > 0n
          ? (() => {
              const bps = (rtoCount * 10000n) / orderCount;
              return `${bps / 100n}.${String(bps % 100n).padStart(2, '0')}`;
            })()
          : '0';
      return { currency_code: row.currency_code, orderCount, aovMinor, rtoRatePct };
    });
  });
}
