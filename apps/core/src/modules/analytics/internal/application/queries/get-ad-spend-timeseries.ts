/**
 * getAdSpendTimeseries — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin query wrapper around computeAdSpendTimeseries (metric engine).
 * The engine is the SOLE computation layer — no ad-hoc SUM(spend_minor) here (D-3).
 *
 * Serializes bigint → string for JSON safety (D-1).
 * Honest-empty: state='no_data' ONLY when the brand has ZERO ad_spend_ledger rows
 * (same EXISTS pattern as get-revenue-timeseries.ts). Within a window with no rows the
 * engine returns [] — that is an empty has_data set, distinct from no_data.
 */

import type { EngineDeps, AdPlatform } from '@brain/metric-engine';
import { computeAdSpendTimeseries, withBrandTxn } from '@brain/metric-engine';
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
 * @param deps      - EngineDeps with raw pg.Pool (rawPgPool, not DbPool wrapper).
 */
export async function getAdSpendTimeseries(
  brandId: string,
  params: { fromDate: Date; toDate: Date; grain: TimeGrain; platform?: AdPlatform },
  deps: EngineDeps,
): Promise<AdSpendTimeseriesResult> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const toStr = params.toDate.toISOString().split('T')[0] as string;
  const platform = params.platform ?? null;

  // EXISTS check — authoritative honest-empty (D-2). Runs inside withBrandTxn so RLS
  // scopes ad_spend_ledger to this brand (FORCE-RLS, migration 0029).
  const hasData = await withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ad_spend_ledger WHERE brand_id = $1) AS exists`,
      [brandId],
    );
    return r.rows[0]?.exists === true;
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
