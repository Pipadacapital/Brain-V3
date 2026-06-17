/**
 * getOrdersTimeseries — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin query wrapper around computeOrdersTimeseries (metric engine).
 * The engine is the SOLE computation layer — no ad-hoc SUM/COUNT here (D-3).
 *
 * Serializes bigint → string for JSON safety (D-1).
 * Honest-empty: state:'no_data' only when the brand has NO ledger rows at all
 * (same EXISTS pattern as get-revenue-timeseries.ts).
 */

import type { EngineDeps } from '@brain/metric-engine';
import { computeOrdersTimeseries, withBrandTxn } from '@brain/metric-engine';
import type { TimeGrain } from '@brain/metric-engine';

export interface OrdersTimeseriesBucketDto {
  bucket: string;          // 'YYYY-MM-DD'
  currency_code: string;
  order_count: string;     // bigint serialized to string (D-1)
  rto_count: string;       // bigint serialized to string (D-1)
  realized_minor: string;  // bigint serialized to string (D-1)
}

export type OrdersTimeseriesResult =
  | { state: 'no_data'; from: string; to: string; grain: TimeGrain }
  | { state: 'has_data'; from: string; to: string; grain: TimeGrain; buckets: OrdersTimeseriesBucketDto[] };

/**
 * getOrdersTimeseries — returns per-bucket order count + RTO count + realized revenue.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param params  - Date range + grain.
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getOrdersTimeseries(
  brandId: string,
  params: { fromDate: Date; toDate: Date; grain: TimeGrain },
  deps: EngineDeps,
): Promise<OrdersTimeseriesResult> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const toStr = params.toDate.toISOString().split('T')[0] as string;

  // EXISTS check — authoritative honest-empty (D-2).
  const hasData = await withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM realized_revenue_ledger WHERE brand_id = $1) AS exists`,
      [brandId],
    );
    return r.rows[0]?.exists === true;
  });

  if (!hasData) {
    return { state: 'no_data', from: fromStr, to: toStr, grain: params.grain };
  }

  const buckets = await computeOrdersTimeseries(brandId, params, deps);

  return {
    state: 'has_data',
    from: fromStr,
    to: toStr,
    grain: params.grain,
    buckets: buckets.map((b) => ({
      bucket: b.bucket,
      currency_code: b.currency_code,
      order_count: String(b.orderCount),
      rto_count: String(b.rtoCount),
      realized_minor: String(b.realizedMinor),
    })),
  };
}
