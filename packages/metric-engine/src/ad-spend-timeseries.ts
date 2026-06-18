/**
 * @brain/metric-engine — computeAdSpendTimeseries
 *
 * Returns per-bucket ad spend for charting, grouped by (bucket, platform, currency_code).
 *
 * The metric engine is the SOLE sanctioned computation layer (ADR-002 / D-3).
 * No ad-hoc SUM(spend_minor) lives outside this package. The single-point as-of read
 * is ad_spend_as_of() (migration 0029); this timeseries is its bucketed sibling — the
 * date_trunc grouping equivalent, kept INSIDE the engine so spend is never summed in
 * app code (mirrors orders-timeseries.ts which buckets realized_revenue_ledger directly).
 *
 * Bucket   = date_trunc(grain, stat_date) — stat_date is click-date-anchored (canonical,
 *            ADR-AD-8). spend is fixed at click-time, so stat_date is the correct anchor.
 * spend_minor = SUM(spend_minor) over the bucket — BIGINT minor units (I-S07, no float).
 *
 * Optional platform filter ('meta' | 'google_ads') narrows to one platform.
 *
 * F-SEC-02: all reads happen inside withBrandTxn so the GUC is transaction-scoped.
 * RLS policy (brand_id = current_setting(...)) scopes rows to the active brand.
 * ad_spend_ledger is FORCE-RLS (migration 0029) — cross-brand read = 0 under brain_app.
 */

import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';
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
 * @param deps    - EngineDeps with raw pg.Pool.
 * @returns       Array of AdSpendTimeseriesBucket, ordered by (bucket, platform, ccy) ASC.
 *                Empty array when no spend rows exist in the window.
 */
export async function computeAdSpendTimeseries(
  brandId: string,
  params: { fromDate: Date; toDate: Date; grain: TimeGrain; platform?: AdPlatform },
  deps: EngineDeps,
): Promise<AdSpendTimeseriesBucket[]> {
  const fromStr = params.fromDate.toISOString().split('T')[0];
  const toStr = params.toDate.toISOString().split('T')[0];
  const grain = params.grain; // 'day' | 'week' — TS-controlled constant, not user-interpolated
  // platform is a typed enum ('meta'|'google_ads'); passed as a bound param ($5), NULL = no filter.
  const platform = params.platform ?? null;

  return withBrandTxn(deps.pool, brandId, async (client) => {
    // date_trunc requires a literal first arg; translate via CASE on $3::text
    // ($3 is a TS-controlled 'day'|'week' constant — never user-interpolated SQL).
    // $5 (platform) is bound: when NULL the platform predicate is a no-op (matches all).
    const sql = `
      SELECT
        date_trunc(
          CASE $3::text WHEN 'week' THEN 'week' ELSE 'day' END,
          stat_date::timestamp
        )::date AS bucket,
        platform,
        currency_code,
        SUM(spend_minor)::text AS spend_minor
      FROM ad_spend_ledger
      WHERE brand_id = $1
        AND stat_date BETWEEN $2::date AND $4::date
        AND ($5::text IS NULL OR platform = $5::text)
      GROUP BY 1, 2, 3
      ORDER BY bucket ASC, platform ASC, currency_code ASC
    `;

    const result = await client.query<{
      bucket: Date;
      platform: string;
      currency_code: string;
      spend_minor: string;
    }>(sql, [brandId, fromStr, grain, toStr, platform]);

    return result.rows.map((row) => ({
      bucket: row.bucket.toISOString().split('T')[0] as string,
      platform: row.platform,
      currency_code: row.currency_code,
      spendMinor: BigInt(row.spend_minor),
    }));
  });
}
