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

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
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
  deps: { srPool: SilverPool },
): Promise<OrdersTimeseriesBucket[]> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const toStr = params.toDate.toISOString().split('T')[0] as string;
  const grain = params.grain === 'week' ? 'week' : 'day'; // TS-controlled; guarded for interpolation

  // MEDALLION REALIGNMENT (Epic 1): read brain_gold.gold_revenue_ledger via withSilverBrand, not PG.
  // realized = non-provisional (canonical, COD-inclusive); RTO = rto_reversal + cod_rto_clawback.
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      bucket: string;
      currency_code: string;
      order_count: string | number;
      rto_count: string | number;
      realized_minor: string | number;
    }>(
      `SELECT
         CAST(date_trunc('${grain}', occurred_at) AS DATE) AS bucket,
         currency_code,
         COUNT(DISTINCT order_id) AS order_count,
         COUNT(DISTINCT CASE WHEN event_type IN ('rto_reversal', 'cod_rto_clawback') THEN order_id END) AS rto_count,
         SUM(CASE WHEN event_type <> 'provisional_recognition' THEN amount_minor ELSE 0 END) AS realized_minor
       FROM brain_gold.gold_revenue_ledger
       WHERE CAST(occurred_at AS DATE) BETWEEN ? AND ?
         AND ${BRAND_PREDICATE}
       GROUP BY 1, 2
       ORDER BY 1 ASC, 2 ASC`,
      [fromStr, toStr],
    );

    return rows.map((row) => ({
      bucket: String(row.bucket).split('T')[0] as string,
      currency_code: row.currency_code,
      orderCount: BigInt(String(row.order_count ?? '0').split('.')[0] || '0'),
      rtoCount: BigInt(String(row.rto_count ?? '0').split('.')[0] || '0'),
      realizedMinor: BigInt(String(row.realized_minor ?? '0').split('.')[0] || '0'),
    }));
  });
}
