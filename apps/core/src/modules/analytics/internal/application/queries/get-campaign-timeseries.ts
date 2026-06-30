/**
 * getCampaignTimeseries — analytics use-case (ADR-002 sole-read-path) for the #32c-ts campaign series.
 *
 * The date-bucketed sibling of getCampaignAttribution: per-bucket attributed revenue per campaign/channel
 * over the date-bearing attribution serving view (mv_gold_marketing_attribution — the same store the
 * gold_campaign_attribution mart is rolled up from), via computeCampaignTimeseries (metric engine) through
 * the withSilverBrand seam (I-ST01 — the engine is the sole Gold reader; the UI never queries the lakehouse
 * directly). Model-switchable (the ledger apportions the SAME realized revenue under every model, so the
 * read filters to ONE model_id — callers default to position_based). NO ad-hoc arithmetic (D-3).
 *
 * Money is bigint minor units + sibling currency_code (never blended, never a float); serialized
 * bigint → string (D-1). Honest no_data when the brand has NO attribution-credit rows at all; an empty
 * has_data window (no rows in the date range) returns buckets:[] — distinct from no_data.
 * brandId from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/campaign-timeseries.ts
 */

import type { SilverPool, AttributionModelId, TimeGrain } from '@brain/metric-engine';
import { computeCampaignTimeseries } from '@brain/metric-engine';
import { hasAttributionCredit } from './_attribution-credit.js';

export interface CampaignTimeseriesBucketDto {
  bucket: string; // 'YYYY-MM-DD'
  campaign_id: string;
  channel: string;
  currency_code: string;
  attributed_revenue_minor: string; // bigint minor → string (signed, net of clawback)
}

export type CampaignTimeseriesResult =
  | { state: 'no_data'; from: string; to: string; grain: TimeGrain; model: AttributionModelId }
  | {
      state: 'has_data';
      from: string;
      to: string;
      grain: TimeGrain;
      model: AttributionModelId;
      buckets: CampaignTimeseriesBucketDto[];
    };

export interface CampaignTimeseriesParams {
  model: AttributionModelId;
  fromDate: Date;
  toDate: Date;
  grain: TimeGrain;
}

/**
 * getCampaignTimeseries — a brand's per-bucket attributed revenue per campaign/channel under a model.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param params  - { model, fromDate, toDate, grain }.
 * @param deps    - The Trino Gold serving pool (mv_gold_marketing_attribution).
 */
export async function getCampaignTimeseries(
  brandId: string,
  params: CampaignTimeseriesParams,
  deps: { srPool: SilverPool },
): Promise<CampaignTimeseriesResult> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const toStr = params.toDate.toISOString().split('T')[0] as string;

  // EXISTS check — authoritative honest-empty (D-2). Reads the SAME store as the compute, so the
  // exists-check and the series never skew (no PG-data-hidden-by-empty-mart class of bug).
  if (!(await hasAttributionCredit(brandId, deps))) {
    return { state: 'no_data', from: fromStr, to: toStr, grain: params.grain, model: params.model };
  }

  const buckets = await computeCampaignTimeseries(brandId, params, deps);

  return {
    state: 'has_data',
    from: fromStr,
    to: toStr,
    grain: params.grain,
    model: params.model,
    buckets: buckets.map((b) => ({
      bucket: b.bucket,
      campaign_id: b.campaignId,
      channel: b.channel,
      currency_code: b.currencyCode,
      attributed_revenue_minor: String(b.attributedRevenueMinor),
    })),
  };
}
