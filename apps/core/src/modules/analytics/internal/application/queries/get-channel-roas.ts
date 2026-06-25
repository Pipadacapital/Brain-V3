/**
 * getChannelRoas — analytics use-case (ADR-002 sole-read-path).
 *
 * Per-channel ROAS = attributed_revenue ÷ ad_spend, from computeChannelRoas (metric engine).
 * Makes blended_roas PER-CHANNEL (joins the attribution credit ledger's channel contribution
 * with ad_spend_ledger). SAME-CURRENCY ONLY; HONEST roas_ratio=null when spend=0 (no
 * divide-by-zero). NO ad-hoc arithmetic here (D-3). Serializes bigint→string (D-1).
 *
 * Honest no_data when the brand has zero marketing-spend rows (no denominator → no ROAS).
 * brandId from session (D-1; NEVER body).
 *
 * V4 PHASE 4b: fully serving — spend-exists from mv_silver_marketing_spend, attribution-exists from
 * mv_gold_marketing_attribution, compute from both — via withSilverBrand. PG is no longer a read
 * source for this surface. (The shared hasAttributionCredit helper + the other attribution
 * surfaces remain on PG until their own re-point slice — re-pointing the helper alone would
 * hide real PG data behind the still-empty lakehouse mart.)
 */

import type { SilverPool, AttributionModelId } from '@brain/metric-engine';
import { computeChannelRoas, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

export interface ChannelRoasDto {
  channel: string;
  currency_code: string;
  attributed_minor: string; // bigint → string (D-1)
  spend_minor: string;      // bigint → string (D-1)
  roas_ratio: string | null; // exact decimal string, or null when spend=0 (honest)
}

export type ChannelRoasResult =
  | { state: 'no_data'; from: string; to: string; model: AttributionModelId }
  | { state: 'not_computed'; from: string; to: string; model: AttributionModelId }
  | {
      state: 'has_data';
      from: string;
      to: string;
      model: AttributionModelId;
      rows: ChannelRoasDto[];
      data_source: 'synthetic' | 'live';
    };

export interface ChannelRoasParams {
  model: AttributionModelId;
  fromDate: Date;
  toDate: Date;
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

export async function getChannelRoas(
  brandId: string,
  params: ChannelRoasParams,
  deps: { srPool: SilverPool },
): Promise<ChannelRoasResult> {
  // Spend-exists + attribution-exists, both via the lakehouse brand-scoped seam (one round trip).
  const { hasSpend, hasCredit } = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    const spend = await scope.runScoped<{ has_row: number }>(
      `SELECT 1 AS has_row FROM brain_serving.mv_silver_marketing_spend WHERE ${BRAND_PREDICATE} LIMIT 1`,
      [],
    );
    const credit = await scope.runScoped<{ has_row: number }>(
      `SELECT 1 AS has_row FROM brain_serving.mv_gold_marketing_attribution WHERE ${BRAND_PREDICATE} LIMIT 1`,
      [],
    );
    return { hasSpend: spend.length > 0, hasCredit: credit.length > 0 };
  });

  // ROAS requires a spend denominator — no spend → no_data (honest, like blended_roas).
  if (!hasSpend) {
    return { state: 'no_data', from: params.fromStr, to: params.toStr, model: params.model };
  }

  // Honest-not-computed (R-10): spend exists but the credit ledger is empty, so every channel's
  // attributed_minor would be 0 (ROAS = 0) — that reads as "ads drove nothing" when really
  // attribution just hasn't run. Surface it distinctly.
  if (!hasCredit) {
    return { state: 'not_computed', from: params.fromStr, to: params.toStr, model: params.model };
  }

  const rows = await computeChannelRoas(
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
      channel: r.channel,
      currency_code: r.currencyCode,
      attributed_minor: String(r.attributedMinor),
      spend_minor: String(r.spendMinor),
      roas_ratio: r.roasRatio,
    })),
    data_source: params.dataSource,
  };
}
