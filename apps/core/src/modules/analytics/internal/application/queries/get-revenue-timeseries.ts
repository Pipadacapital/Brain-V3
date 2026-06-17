/**
 * getRevenueTimeseries — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin query wrapper around computeRevenueTimeseries (metric engine).
 * The engine is the SOLE computation layer — no ad-hoc SUM here (D-3).
 *
 * Serializes bigint → string for JSON safety (D-1).
 * Honest-empty: if brand has no ledger rows in the window, engine returns [].
 * Returns { state:'no_data' } only when the brand has NO rows at all (same
 * EXISTS pattern as get-revenue-metrics.ts).
 */

import type { EngineDeps } from '@brain/metric-engine';
import { computeRevenueTimeseries, withBrandTxn } from '@brain/metric-engine';
import type { TimeGrain } from '@brain/metric-engine';

export interface TimeseriesBucketDto {
  bucket: string;            // 'YYYY-MM-DD'
  currency_code: string;
  realized_minor: string;    // bigint serialized to string (D-1)
  provisional_minor: string; // bigint serialized to string (D-1)
}

export type RevenueTimeseriesResult =
  | { state: 'no_data'; from: string; to: string; grain: TimeGrain }
  | { state: 'has_data'; from: string; to: string; grain: TimeGrain; buckets: TimeseriesBucketDto[] };

/**
 * getRevenueTimeseries — returns per-bucket realized + provisional revenue.
 *
 * @param brandId   - Brand UUID (from session — D-1).
 * @param params    - Date range + grain.
 * @param deps      - EngineDeps with raw pg.Pool (rawPgPool, not DbPool wrapper).
 */
export async function getRevenueTimeseries(
  brandId: string,
  params: { fromDate: Date; toDate: Date; grain: TimeGrain },
  deps: EngineDeps,
): Promise<RevenueTimeseriesResult> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const toStr = params.toDate.toISOString().split('T')[0] as string;

  // EXISTS check — authoritative honest-empty (D-2). Same pattern as get-revenue-metrics.
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

  const buckets = await computeRevenueTimeseries(brandId, params, deps);

  return {
    state: 'has_data',
    from: fromStr,
    to: toStr,
    grain: params.grain,
    buckets: buckets.map((b) => ({
      bucket: b.bucket,
      currency_code: b.currency_code,
      realized_minor: String(b.realizedMinor),
      provisional_minor: String(b.provisionalMinor),
    })),
  };
}
