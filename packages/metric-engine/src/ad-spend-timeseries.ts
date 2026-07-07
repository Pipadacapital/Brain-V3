/**
 * @brain/metric-engine — computeAdSpendTimeseries
 *
 * Returns per-bucket ad spend for charting, grouped by (bucket, platform, currency_code).
 *
 * The metric engine is the SOLE sanctioned computation layer (ADR-002 / D-3).
 * No ad-hoc SUM(spend_minor) lives outside this package. This timeseries is the bucketed
 * spend read, kept INSIDE the engine so spend is never summed in app code (mirrors
 * orders-timeseries.ts which buckets the revenue ledger directly).
 *
 * Bucket   = date_trunc(grain, stat_date) — stat_date is click-date-anchored (canonical,
 *            ADR-AD-8). spend is fixed at click-time, so stat_date is the correct anchor.
 * spend_minor = SUM(spend_minor) over the bucket — BIGINT minor units (I-S07, no float).
 *
 * Optional platform filter ('meta' | 'google_ads') narrows to one platform.
 *
 * ── PHASE G re-point: reads the lakehouse Silver entity brain_silver.silver_marketing_spend via
 *    withSilverBrand (I-ST01), NOT PG ad_spend_ledger. PG is no longer a spend READ source (write
 *    SoR only). Per-brand isolation is enforced at the Silver read seam (BRAND_PREDICATE → brand_id = ?).
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
import { spendView } from './measurement-migration.js';
import type { TimeGrain } from './revenue-timeseries.js';

export type AdPlatform = 'meta' | 'google_ads';

export interface AdSpendTimeseriesBucket {
  /** ISO date string of the bucket start: 'YYYY-MM-DD' */
  bucket: string;
  /** 'meta' | 'google_ads' */
  platform: string;
  /** ISO 4217 currency code */
  currency_code: string;
  /** Ad spend minor units for this (bucket, platform, currency) — BIGINT (I-S07) */
  spendMinor: bigint;
}

/**
 * computeAdSpendTimeseries — per-bucket ad spend grouped by (platform, currency_code).
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param params  - Date window + grain + optional platform filter.
 * @param deps    - The StarRocks Silver pool — silver_marketing_spend via withSilverBrand.
 * @returns       Array of AdSpendTimeseriesBucket, ordered by (bucket, platform, ccy) ASC.
 *                Empty array when no spend rows exist in the window.
 */
export async function computeAdSpendTimeseries(
  brandId: string,
  params: { fromDate: Date; toDate: Date; grain: TimeGrain; platform?: AdPlatform },
  deps: { srPool: SilverPool; measurementMartsMigration?: boolean },
): Promise<AdSpendTimeseriesBucket[]> {
  const fromStr = params.fromDate.toISOString().split('T')[0]; // Date-formatted → injection-safe
  const toStr = params.toDate.toISOString().split('T')[0];
  // grain is a TS-controlled 'day'|'week' constant — whitelisted, never user-interpolated.
  const grainUnit = params.grain === 'week' ? 'week' : 'day';
  // platform is a typed enum ('meta'|'google_ads'); whitelisted before interpolation.
  const platform: AdPlatform | null =
    params.platform === 'meta' || params.platform === 'google_ads' ? params.platform : null;
  const platformPredicate = platform ? `AND platform = '${platform}'` : '';

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // date_trunc requires a literal unit (grainUnit is whitelisted above). The seam injects
    // brand_id = ? at ${BRAND_PREDICATE}. All other interpolated values are Date-formatted or enum.
    const rows = await scope.runScoped<{
      bucket: string;
      platform: string;
      currency_code: string;
      spend_minor: string | number;
    }>(
      `SELECT date_format(date_trunc('${grainUnit}', CAST(stat_date AS TIMESTAMP)), '%Y-%m-%d') AS bucket,
              platform,
              currency_code,
              SUM(spend_minor) AS spend_minor
         FROM ${spendView(deps.measurementMartsMigration)}
        WHERE stat_date BETWEEN DATE '${fromStr}' AND DATE '${toStr}'
          ${platformPredicate}
          AND ${BRAND_PREDICATE}
        GROUP BY 1, platform, currency_code
        ORDER BY 1 ASC, platform ASC, currency_code ASC`,
      [],
    );

    return rows.map((row) => ({
      bucket: String(row.bucket).split('T')[0] as string,
      platform: row.platform,
      currency_code: row.currency_code,
      spendMinor: BigInt(String(row.spend_minor).split('.')[0] ?? '0'),
    }));
  });
}
