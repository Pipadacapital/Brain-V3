/**
 * @brain/metric-engine — computeCampaignTimeseries (#32c-ts — date-bucketed per-campaign/channel
 * attributed revenue).
 *
 * The TIME-GRAIN sibling of computeCampaignAttribution. The pre-rolled gold_campaign_attribution mart
 * (mv_gold_campaign_attribution) is a FULL all-time roll-up — one row per (brand, platform, campaign,
 * model, currency) with NO time dimension — so a date-bucketed series cannot come from it. This reads
 * the date-bearing attribution serving view it is rolled up FROM: brain_serving.mv_gold_marketing_attribution
 * (the signed credit ledger), the SAME store computeAttributionReconciliationRate + hasAttributionCredit
 * read. We bucket economic_effective_at by grain and group by campaign_id + channel + currency_code.
 *
 * MODEL-SWITCHABLE: the ledger apportions the SAME realized revenue under EVERY attribution model, so this
 * read MUST filter to a single model_id (callers default to position_based) — summing across models would
 * N×-count. The model id is a typed AttributionModelId, guarded to a safe identifier before interpolation.
 *
 * MONEY: attributed_revenue_minor is bigint minor units + sibling currency_code, NEVER blended across
 * currencies, NEVER a float. credited_revenue_minor is SIGNED — summing over credit + clawback rows nets
 * the clawback exactly (same semantics as the channel reconciliation read, which also does not partition
 * by row_kind). Empty array when no credit rows fall in the window (honest — never a fabricated 0 bucket).
 *
 * @see packages/metric-engine/src/campaign-attribution.ts — the all-time roll-up sibling
 * @see packages/metric-engine/src/attribution-reconciliation.ts — the per-channel windowed read
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
import type { TimeGrain } from './revenue-timeseries.js';
import type { AttributionModelId } from './attribution-models.js';

export interface CampaignTimeseriesBucket {
  /** ISO date string of the bucket start: 'YYYY-MM-DD'. */
  bucket: string;
  /** Ad-platform campaign id (carried from the touchpoint utm_campaign). */
  campaignId: string;
  /** Journey channel the credit was apportioned to (e.g. 'meta', 'google', 'direct'). */
  channel: string;
  /** ISO 4217 currency code (money is per-currency, never blended). */
  currencyCode: string;
  /** Attributed revenue for the (bucket, campaign, channel, currency) under the model, net of clawback. */
  attributedRevenueMinor: bigint;
}

/**
 * computeCampaignTimeseries — per-bucket attributed revenue per campaign/channel under a model.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param params  - { model, fromDate, toDate, grain } — the attribution model + inclusive window + grain.
 * @param deps    - The Trino Gold serving pool (mv_gold_marketing_attribution).
 * @returns       Array of CampaignTimeseriesBucket, ordered by (bucket, campaign, channel) ASC.
 *                Empty array when no credit rows exist for the model in the window.
 */
export async function computeCampaignTimeseries(
  brandId: string,
  params: { model: AttributionModelId; fromDate: Date; toDate: Date; grain: TimeGrain },
  deps: { srPool: SilverPool },
): Promise<CampaignTimeseriesBucket[]> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const toStr = params.toDate.toISOString().split('T')[0] as string;
  // 'day' | 'week' — TS-controlled constant; guard before interpolating into date_trunc.
  const grain = params.grain === 'week' ? 'week' : 'day';
  // model is a typed AttributionModelId; guard to a safe identifier before interpolation.
  const model = /^[a-z0-9_]+$/i.test(params.model) ? params.model : '__invalid__';

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally after the window `?`s.
    // Bucket by economic_effective_at (the attribution windowing dimension — same as by-channel).
    const rows = await scope.runScoped<{
      bucket: string;
      campaign_id: string | null;
      channel: string | null;
      currency_code: string;
      attributed_revenue_minor: string | number;
    }>(
      `SELECT
         strftime(date_trunc('${grain}', economic_effective_at), '%Y-%m-%d') AS bucket,
         campaign_id,
         channel,
         currency_code,
         COALESCE(SUM(credited_revenue_minor), 0) AS attributed_revenue_minor
       FROM brain_serving.mv_gold_marketing_attribution
       WHERE model_id = '${model}'
         AND campaign_id IS NOT NULL AND campaign_id <> ''
         AND CAST(economic_effective_at AS DATE) BETWEEN ? AND ?
         AND ${BRAND_PREDICATE}
       GROUP BY 1, 2, 3, 4
       ORDER BY 1 ASC, 2 ASC, 3 ASC`,
      [fromStr, toStr],
    );

    return rows.map((row) => ({
      bucket: String(row.bucket).split('T')[0] as string,
      campaignId: row.campaign_id ?? '',
      channel: row.channel ?? '',
      currencyCode: row.currency_code,
      attributedRevenueMinor: BigInt(String(row.attributed_revenue_minor ?? '0').split('.')[0] || '0'),
    }));
  });
}
