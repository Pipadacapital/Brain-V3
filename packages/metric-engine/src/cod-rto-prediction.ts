/**
 * cod-rto-prediction — RTO-risk distribution from the MULTI-SOURCE Silver mart `silver_checkout_signal`
 * (StarRocks brain_silver), signal_type='rto_predict', read through the withSilverBrand seam.
 *
 * silver_checkout_signal folds the GoKwik RTO-Predict stream (one prediction per (order, request_id),
 * risk_flag ∈ high|medium|low|control|unknown — VERBATIM categorical, never a fabricated number) into
 * the canonical payments-checkout-signal Silver surface. This read surfaces the LATEST prediction per
 * order over a window, so the COD-RTO decisioning surface can answer "how many open-COD orders are
 * high-risk right now?".
 *
 * ── WHY silver_checkout_signal (re-point, payments-category Silver): the original read the raw
 *    gokwik.rto_predict.v1 rows from PG bronze_events — but under the Iceberg-sole read posture those
 *    events are not in PG bronze, so that read returned empty. silver_checkout_signal is the canonical,
 *    Silver-tier home for payments/checkout signals and is the correct seam. Shape/contract unchanged.
 *
 * HONEST EMPTY: 0 predictions → hasData=false (never a fabricated zero). DEV-HONESTY: a synthetic
 * source (is_synthetic) drives the UI Synthetic badge — coverage is never faked.
 *
 * I-ST01: the metric-engine is the SOLE Silver reader; reads go through withSilverBrand (brand
 * predicate injected at the seam). brandId is from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/cod-rto-rates.ts (sibling silver re-point) + silver-deps.ts (the seam)
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

const WINDOW_DAYS = 30;

export interface RtoRiskDistributionResult {
  hasData: boolean;
  /** Distinct orders with a prediction in-window (counted by their LATEST prediction). */
  orderCount: bigint;
  high: bigint;
  medium: bigint;
  low: bigint;
  control: bigint;
  unknown: bigint;
  dataSource: 'live' | 'synthetic';
}

interface RtoDistRow {
  total: string | number;
  high: string | number;
  medium: string | number;
  low: string | number;
  control: string | number;
  unknown: string | number;
  synthetic_cnt: string | number;
}

export async function computeRtoRiskDistribution(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<RtoRiskDistributionResult> {
  // Latest prediction per order (row_number over occurred_at DESC), then bucket by the categorical flag.
  // The brand predicate is injected at the seam (${BRAND_PREDICATE}) — inside the CTE WHERE.
  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) =>
    scope.runScoped<RtoDistRow>(
      `WITH latest AS (
         SELECT order_id, risk_flag, is_synthetic,
                ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY occurred_at DESC) AS rn
           FROM brain_serving.mv_silver_checkout_signal
          WHERE signal_type = 'rto_predict'
            AND order_id IS NOT NULL
            AND occurred_at >= (NOW() - INTERVAL ${WINDOW_DAYS} DAY)
            AND ${BRAND_PREDICATE}
       )
       SELECT
         COUNT(*)                                                              AS total,
         SUM(CASE WHEN risk_flag = 'high'    THEN 1 ELSE 0 END)                AS high,
         SUM(CASE WHEN risk_flag = 'medium'  THEN 1 ELSE 0 END)                AS medium,
         SUM(CASE WHEN risk_flag = 'low'     THEN 1 ELSE 0 END)                AS low,
         SUM(CASE WHEN risk_flag = 'control' THEN 1 ELSE 0 END)                AS control,
         SUM(CASE WHEN risk_flag IS NULL
                    OR risk_flag NOT IN ('high','medium','low','control')
                  THEN 1 ELSE 0 END)                                          AS unknown,
         SUM(CASE WHEN is_synthetic THEN 1 ELSE 0 END)                        AS synthetic_cnt
       FROM latest
       WHERE rn = 1`,
      [],
    ),
  );

  const row = rows[0];
  const orderCount = BigInt(String(row?.total ?? '0'));
  if (orderCount === 0n) {
    return {
      hasData: false,
      orderCount: 0n,
      high: 0n,
      medium: 0n,
      low: 0n,
      control: 0n,
      unknown: 0n,
      dataSource: 'live',
    };
  }
  return {
    hasData: true,
    orderCount,
    high: BigInt(String(row?.high ?? '0')),
    medium: BigInt(String(row?.medium ?? '0')),
    low: BigInt(String(row?.low ?? '0')),
    control: BigInt(String(row?.control ?? '0')),
    unknown: BigInt(String(row?.unknown ?? '0')),
    dataSource: BigInt(String(row?.synthetic_cnt ?? '0')) > 0n ? 'synthetic' : 'live',
  };
}
