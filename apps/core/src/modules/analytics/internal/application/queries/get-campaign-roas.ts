/**
 * getCampaignRoas — analytics use-case (ADR-002 sole-read-path).
 *
 * H8: per-CAMPAIGN ROAS = attributed_revenue ÷ ad_spend, from computeCampaignRoas (metric engine).
 * The granular sibling of getChannelRoas — joins gold_marketing_attribution × silver_marketing_spend
 * on campaign_id (the level marketers optimize). SAME-CURRENCY ONLY; HONEST roas_ratio=null when
 * spend=0 (no divide-by-zero). NO ad-hoc arithmetic here (D-3). Serializes bigint→string (D-1).
 *
 * Honest no_data when the brand has zero campaign spend rows (no denominator → no ROAS); honest
 * not_computed when spend exists but the credit ledger is empty (attribution hasn't run yet — R-10).
 * brandId from session (D-1; NEVER body).
 */

import type { SilverPool, AttributionModelId } from '@brain/metric-engine';
import { computeCampaignRoas, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

export interface CampaignRoasDto {
  campaign_id: string;
  campaign_name: string | null;
  currency_code: string;
  attributed_minor: string; // bigint → string (D-1)
  spend_minor: string;      // bigint → string (D-1)
  roas_ratio: string | null; // exact decimal string, or null when spend=0 (honest)
}

export type CampaignRoasResult =
  | { state: 'no_data'; from: string; to: string; model: AttributionModelId }
  | { state: 'not_computed'; from: string; to: string; model: AttributionModelId }
  | {
      state: 'has_data';
      from: string;
      to: string;
      model: AttributionModelId;
      rows: CampaignRoasDto[];
    };

export interface CampaignRoasParams {
  model: AttributionModelId;
  fromDate: Date;
  toDate: Date;
  fromStr: string;
  toStr: string;
}

export async function getCampaignRoas(
  brandId: string,
  params: CampaignRoasParams,
  deps: { srPool: SilverPool },
): Promise<CampaignRoasResult> {
  const { hasSpend, hasCredit } = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    const spend = await scope.runScoped<{ has_row: number }>(
      `SELECT 1 AS has_row FROM brain_silver.silver_marketing_spend
        WHERE campaign_id IS NOT NULL AND ${BRAND_PREDICATE} LIMIT 1`,
      [],
    );
    const credit = await scope.runScoped<{ has_row: number }>(
      `SELECT 1 AS has_row FROM brain_gold.gold_marketing_attribution
        WHERE campaign_id IS NOT NULL AND ${BRAND_PREDICATE} LIMIT 1`,
      [],
    );
    return { hasSpend: spend.length > 0, hasCredit: credit.length > 0 };
  });

  if (!hasSpend) {
    return { state: 'no_data', from: params.fromStr, to: params.toStr, model: params.model };
  }
  if (!hasCredit) {
    return { state: 'not_computed', from: params.fromStr, to: params.toStr, model: params.model };
  }

  const rows = await computeCampaignRoas(
    brandId,
    { model: params.model, fromDate: params.fromDate, toDate: params.toDate },
    deps,
  );

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    model: params.model,
    rows: rows.map((r) => ({
      campaign_id: r.campaignId,
      campaign_name: r.campaignName,
      currency_code: r.currencyCode,
      attributed_minor: String(r.attributedMinor),
      spend_minor: String(r.spendMinor),
      roas_ratio: r.roasRatio,
    })),
  };
}
