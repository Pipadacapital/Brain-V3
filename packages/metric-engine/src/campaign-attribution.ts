/**
 * @brain/metric-engine — computeCampaignAttribution (#32c — per-campaign attributed revenue + ROAS).
 *
 * The SOLE reader of the Gold mart gold_campaign_attribution, served through the Trino serving view
 * brain_serving.mv_gold_campaign_attribution via withSilverBrand (I-ST01 — the engine is the only
 * Gold reader; the UI never queries the lakehouse directly). The mart rolls the SIGNED attribution
 * credit ledger up to per-(brand_id, platform, campaign_id, model_id, currency_code):
 * attributed_revenue_minor (net of clawback), LEFT-JOINed to the campaign spend surface for
 * spend_minor + campaign_name, with roas_bps = attributed_revenue_minor*10000 ÷ spend_minor
 * (integer basis points; NULL when spend = 0).
 *
 * MODEL-SWITCHABLE: the ledger apportions the SAME realized revenue under EVERY attribution model,
 * so this read MUST filter to a single model_id (default position_based) — summing across models
 * would N×-count. The model id is a typed AttributionModelId, guarded to a safe identifier before
 * interpolation.
 *
 * MONEY: bigint minor units + sibling currency_code, NEVER blended across currencies, NEVER a float.
 * roas_bps is integer basis points; the read-time ratio = roas_bps / 10000 is rendered as an EXACT
 * 4dp decimal string from integer operands (no float); null when spend = 0 (honest — never a
 * fabricated ∞). hasData=false when the brand has no campaign-attribution rows for the model.
 *
 * @see db/iceberg/spark/gold/gold_campaign_attribution.py + db/trino/views/mv_gold_campaign_attribution.sql
 * @see packages/metric-engine/src/attribution-campaign-roas.ts — the per-touch ledger ROAS sibling
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
import type { AttributionModelId } from './attribution-models.js';

/** Coerce a Trino numeric (string|number) to bigint, dropping any fractional tail. */
function toBig(v: string | number | null | undefined): bigint {
  return BigInt(String(v ?? '0').split('.')[0] ?? '0');
}

/** Coerce a nullable Trino numeric to bigint | null (null stays null — honest "no spend, no ROAS"). */
function toBigOrNull(v: string | number | null | undefined): bigint | null {
  return v === null || v === undefined ? null : BigInt(String(v).split('.')[0] ?? '0');
}

/**
 * Render integer basis points (ratio × 10000) as an EXACT 4dp decimal ratio string (no float).
 * e.g. 25000 bps → '2.5000'; null when bps is null (spend = 0).
 */
function bpsToRatioString(bps: bigint | null): string | null {
  if (bps === null) return null;
  const sign = bps < 0n ? '-' : '';
  const abs = bps < 0n ? -bps : bps;
  const whole = abs / 10000n;
  const frac = abs % 10000n;
  return `${sign}${whole.toString()}.${frac.toString().padStart(4, '0')}`;
}

export interface CampaignAttributionRow {
  /** Ad platform (e.g. 'meta', 'google_ads'). */
  platform: string;
  /** Ad-platform campaign id (carried from the touchpoint utm_campaign / spend surface). */
  campaignId: string;
  /** Human-readable campaign name from the spend side (null when spend has no name). */
  campaignName: string | null;
  currencyCode: string;
  /** Attributed revenue for the campaign under the model (net of clawback), bigint minor units. */
  attributedRevenueMinor: bigint;
  /** Ad spend for the campaign, bigint minor units (0 when the campaign has attribution but no spend). */
  spendMinor: bigint;
  /** Orders the campaign was credited for under the model. */
  attributedOrderCount: bigint;
  /** Integer basis points (attributed ÷ spend × 10000); null when spend = 0. */
  roasBps: bigint | null;
  /** roas_bps / 10000 as a 4dp string from exact operands; null when spend = 0 (honest). */
  roasRatio: string | null;
}

export interface CampaignAttributionResult {
  /** True iff the brand has ANY campaign-attribution row for the model (honest no_data). */
  hasData: boolean;
  /** The attribution model the rows were computed under (echoed for the UI selector). */
  model: AttributionModelId;
  /** Per-campaign rows (attributed_revenue_minor desc), one per (platform, campaign, currency). */
  rows: CampaignAttributionRow[];
}

interface CampaignAttrRow {
  platform: string | null;
  campaign_id: string | null;
  model_id: string;
  currency_code: string;
  campaign_name: string | null;
  attributed_revenue_minor: string | number;
  spend_minor: string | number;
  attributed_order_count: string | number;
  roas_bps: string | number | null;
}

/**
 * computeCampaignAttribution — per-campaign attributed revenue + spend + ROAS under a model (#32c).
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param params  - { model } — the attribution model to read (callers default to position_based).
 * @param deps    - The Gold serving pool (mv_gold_campaign_attribution).
 * @returns       Per-campaign rows for the model; hasData=false when the brand has no rows.
 */
export async function computeCampaignAttribution(
  brandId: string,
  params: { model: AttributionModelId },
  deps: { srPool: SilverPool },
): Promise<CampaignAttributionResult> {
  // model is a typed AttributionModelId; guard to a safe identifier before interpolation.
  const model = /^[a-z0-9_]+$/i.test(params.model) ? params.model : '__invalid__';

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally to its single `?`.
    const rows = await scope.runScoped<CampaignAttrRow>(
      `SELECT platform, campaign_id, model_id, currency_code, campaign_name,
              attributed_revenue_minor, spend_minor, attributed_order_count, roas_bps
         FROM brain_serving.mv_gold_campaign_attribution
        WHERE model_id = '${model}'
          AND ${BRAND_PREDICATE}
        ORDER BY attributed_revenue_minor DESC, campaign_id ASC`,
      [],
    );

    if (rows.length === 0) {
      return { hasData: false, model: params.model, rows: [] };
    }

    const out: CampaignAttributionRow[] = rows.map((r) => {
      const roasBps = toBigOrNull(r.roas_bps);
      return {
        platform: r.platform ?? '',
        campaignId: r.campaign_id ?? '',
        campaignName: r.campaign_name ?? null,
        currencyCode: r.currency_code,
        attributedRevenueMinor: toBig(r.attributed_revenue_minor),
        spendMinor: toBig(r.spend_minor),
        attributedOrderCount: toBig(r.attributed_order_count),
        roasBps,
        roasRatio: bpsToRatioString(roasBps),
      };
    });

    return { hasData: true, model: params.model, rows: out };
  });
}
