/**
 * getAdSpendTimeseries — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin query wrapper around computeAdSpendTimeseries (metric engine).
 * The engine is the SOLE computation layer — no ad-hoc SUM(spend_minor) here (D-3).
 *
 * Serializes bigint → string for JSON safety (D-1).
 * Honest-empty: state='no_data' ONLY when the brand has ZERO marketing-spend rows
 * (same EXISTS pattern as get-revenue-timeseries.ts). Within a window with no rows the
 * engine returns [] — that is an empty has_data set, distinct from no_data.
 *
 * V4 PHASE 4b: reads the serving mv (brain_serving.mv_silver_marketing_spend) via
 * withSilverBrand — PG ad_spend_ledger is no longer a read source (write SoR only).
 */

import type { SilverPool, AdPlatform } from '@brain/metric-engine';
import { computeAdSpendTimeseries, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';
import type { TimeGrain } from '@brain/metric-engine';

export interface AdSpendTimeseriesBucketDto {
  bucket: string;          // 'YYYY-MM-DD'
  platform: string;        // 'meta' | 'google_ads'
  currency_code: string;
  spend_minor: string;     // bigint serialized to string (D-1)
}

export type AdSpendTimeseriesResult =
  | { state: 'no_data'; from: string; to: string; grain: TimeGrain; platform: string | null }
  | {
      state: 'has_data';
      from: string;
      to: string;
      grain: TimeGrain;
      platform: string | null;
      buckets: AdSpendTimeseriesBucketDto[];
    };

/**
 * getAdSpendTimeseries — returns per-bucket ad spend (platform, currency).
 *
 * @param brandId   - Brand UUID (from session — D-1).
 * @param params    - Date range + grain + optional platform filter.
 * @param deps      - The StarRocks Silver pool — silver_marketing_spend via withSilverBrand.
 */
export async function getAdSpendTimeseries(
  brandId: string,
  params: { fromDate: Date; toDate: Date; grain: TimeGrain; platform?: AdPlatform },
  deps: { srPool: SilverPool },
): Promise<AdSpendTimeseriesResult> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const toStr = params.toDate.toISOString().split('T')[0] as string;
  const platform = params.platform ?? null;

  // EXISTS check — authoritative honest-empty (D-2). Reads the lakehouse Silver entity
  // through the brand-scoped seam (BRAND_PREDICATE → brand_id = ?), no window filter.
  const hasData = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    const r = await scope.runScoped<{ has_row: number }>(
      `SELECT 1 AS has_row FROM brain_serving.mv_silver_marketing_spend WHERE ${BRAND_PREDICATE} LIMIT 1`,
      [],
    );
    return r.length > 0;
  });

  if (!hasData) {
    return { state: 'no_data', from: fromStr, to: toStr, grain: params.grain, platform };
  }

  const buckets = await computeAdSpendTimeseries(brandId, params, deps);

  return {
    state: 'has_data',
    from: fromStr,
    to: toStr,
    grain: params.grain,
    platform,
    buckets: buckets.map((b) => ({
      bucket: b.bucket,
      platform: b.platform,
      currency_code: b.currency_code,
      spend_minor: String(b.spendMinor),
    })),
  };
}
