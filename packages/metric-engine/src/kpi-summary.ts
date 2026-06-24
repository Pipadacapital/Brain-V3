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

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

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
  deps: { srPool: SilverPool },
): Promise<KpiSummaryResult[]> {
  // Exclusive upper bound = asOf + 1 day, so `occurred_at < asOfExclusive` is the SARGABLE equivalent of
  // `CAST(occurred_at AS DATE) <= asOf` — wrapping the column in CAST defeats StarRocks partition pruning
  // + zone-map skipping on the new date-partitioned gold_revenue_ledger (audit PF-5/H4). Raw-column
  // comparison prunes future partitions and skips by zone-map.
  const asOfExclusiveStr = new Date(asOf.getTime() + 86_400_000).toISOString().split('T')[0] as string;

  // MEDALLION REALIGNMENT (Epic 1): read the lakehouse (brain_gold.gold_revenue_ledger) via
  // withSilverBrand — NOT the PostgreSQL ledger. Realized = every non-provisional event (canonical,
  // COD-inclusive); RTO = returns/clawbacks (rto_reversal + cod_rto_clawback). Ratios computed in TS.
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      currency_code: string;
      realized_minor: string | number;
      provisional_minor: string | number;
      order_count: string | number;
      rto_count: string | number;
    }>(
      `SELECT
         currency_code,
         SUM(CASE WHEN event_type <> 'provisional_recognition' THEN amount_minor ELSE 0 END) AS realized_minor,
         SUM(CASE WHEN event_type = 'provisional_recognition' THEN amount_minor ELSE 0 END)  AS provisional_minor,
         COUNT(DISTINCT order_id) AS order_count,
         COUNT(DISTINCT CASE WHEN event_type IN ('rto_reversal', 'cod_rto_clawback') THEN order_id END) AS rto_count
       FROM brain_gold.gold_revenue_ledger
       WHERE occurred_at < ?
         AND ${BRAND_PREDICATE}
       GROUP BY currency_code
       ORDER BY currency_code`,
      [asOfExclusiveStr],
    );

    return rows.map((row) => {
      const orderCount = BigInt(String(row.order_count ?? '0').split('.')[0] || '0');
      const realizedMinor = BigInt(String(row.realized_minor ?? '0').split('.')[0] || '0');
      const rtoCount = BigInt(String(row.rto_count ?? '0').split('.')[0] || '0');
      const aovMinor = orderCount > 0n ? realizedMinor / orderCount : 0n;
      // RTO rate as a 2dp string from exact integer basis-points (no float).
      const rtoRatePct =
        orderCount > 0n
          ? (() => {
              const bps = (rtoCount * 10000n) / orderCount; // = pct × 100
              return `${bps / 100n}.${String(bps % 100n).padStart(2, '0')}`;
            })()
          : '0';
      return {
        currency_code: row.currency_code,
        realizedMinor,
        provisionalMinor: BigInt(String(row.provisional_minor ?? '0').split('.')[0] || '0'),
        orderCount,
        aovMinor,
        rtoRatePct,
      };
    });
  });
}
