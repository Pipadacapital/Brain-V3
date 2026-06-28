/**
 * getCampaignAttribution — analytics use-case (ADR-002 sole-read-path) for the #32c per-campaign ROAS.
 *
 * Per-campaign attributed revenue + spend + ROAS over the Gold mart gold_campaign_attribution, via
 * computeCampaignAttribution (metric engine) through the withSilverBrand seam (I-ST01 — the engine is
 * the sole Gold reader; the UI never queries the lakehouse directly). Model-switchable (the ledger
 * apportions the SAME realized revenue under every model, so the read filters to ONE model_id — the
 * caller picks a default, e.g. position_based). NO ad-hoc arithmetic (D-3); the mart pre-rolls the
 * grain + the integer-bps ROAS.
 *
 * Money is bigint minor units + sibling currency_code (never blended, never a float); serialized
 * bigint → string (D-1). roas_ratio is an exact 4dp string from integer operands; null when spend = 0.
 * Honest no_data when the brand has no campaign-attribution rows for the model. brandId from session
 * (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/campaign-attribution.ts
 */

import type { SilverPool, AttributionModelId } from '@brain/metric-engine';
import { computeCampaignAttribution } from '@brain/metric-engine';

export interface CampaignAttributionRowDto {
  platform: string;
  campaign_id: string;
  campaign_name: string | null;
  currency_code: string;
  attributed_revenue_minor: string; // bigint minor → string (signed, net of clawback)
  spend_minor: string; // bigint minor → string
  attributed_order_count: string; // bigint → string
  roas_bps: string | null; // integer basis points → string; null when spend = 0
  roas_ratio: string | null; // roas_bps/10000 as a 4dp string; null when spend = 0
}

export type CampaignAttributionResult =
  | { state: 'no_data'; model: AttributionModelId }
  | {
      state: 'has_data';
      model: AttributionModelId;
      rows: CampaignAttributionRowDto[];
    };

export interface CampaignAttributionParams {
  model: AttributionModelId;
}

/**
 * getCampaignAttribution — a brand's per-campaign attributed revenue + ROAS under a model.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param params  - { model } — the attribution model to read.
 * @param deps    - The Trino Gold serving pool (mv_gold_campaign_attribution).
 */
export async function getCampaignAttribution(
  brandId: string,
  params: CampaignAttributionParams,
  deps: { srPool: SilverPool },
): Promise<CampaignAttributionResult> {
  const result = await computeCampaignAttribution(brandId, { model: params.model }, deps);

  if (!result.hasData) {
    return { state: 'no_data', model: params.model };
  }

  return {
    state: 'has_data',
    model: result.model,
    rows: result.rows.map((r) => ({
      platform: r.platform,
      campaign_id: r.campaignId,
      campaign_name: r.campaignName,
      currency_code: r.currencyCode,
      attributed_revenue_minor: String(r.attributedRevenueMinor),
      spend_minor: String(r.spendMinor),
      attributed_order_count: String(r.attributedOrderCount),
      roas_bps: r.roasBps === null ? null : String(r.roasBps),
      roas_ratio: r.roasRatio,
    })),
  };
}
