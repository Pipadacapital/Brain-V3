/**
 * @brain/metric-engine — campaign/ad-level ROAS (per-campaign attributed ÷ ad_spend, Tier-0).
 *
 * H8 read seam: makes ROAS per-CAMPAIGN (the level marketers actually optimize), the granular
 * sibling of computeChannelRoas. For each campaign_id, ROAS = attributed_revenue ÷ ad_spend.
 *   • numerator   = Σ credited_revenue_minor per campaign_id (net of clawback) from
 *                   brain_gold.gold_marketing_attribution.
 *   • denominator = Σ spend_minor per campaign_id from brain_silver.silver_marketing_spend.
 * campaign_id is carried on BOTH marts (the deterministic join key — no fuzzy match).
 *
 * SAME-CURRENCY ONLY (mirrors channel/blended ROAS): per currency_code, never blended across
 * currencies. HONEST: roasRatio is reported ONLY where spend>0; spend=0 → null (never a fabricated
 * ∞, never divide-by-zero). The two exact BIGINT operands are always returned so the consumer
 * re-derives the ratio exactly (no silent float rounding). Reads the lakehouse via withSilverBrand
 * (I-ST01); PG is not a read source.
 *
 * @see packages/metric-engine/src/attribution-channel-roas.ts (the channel-grain sibling)
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
import { spendView } from './measurement-migration.js';
import type { AttributionModelId } from './attribution-models.js';

/** Format an exact BIGINT ratio to a fixed-precision decimal string (no float). */
function exactRatioString(numerator: bigint, denominator: bigint, fractionalDigits = 4): string {
  const scale = 10n ** BigInt(fractionalDigits);
  const scaled = (numerator * scale) / denominator;
  const intPart = scaled / scale;
  const fracPart = scaled % scale;
  const absFrac = fracPart < 0n ? -fracPart : fracPart;
  const sign = scaled < 0n ? '-' : '';
  const absInt = intPart < 0n ? -intPart : intPart;
  return `${sign}${absInt.toString()}.${absFrac.toString().padStart(fractionalDigits, '0')}`;
}

export interface CampaignRoasRow {
  /** The ad-platform campaign id (deterministic join key across both marts). */
  campaignId: string;
  /** Human-readable campaign name from the spend side (null when spend has no name). */
  campaignName: string | null;
  currencyCode: string;
  /** Attributed revenue for the campaign (net of clawback), BIGINT minor units. */
  attributedMinor: bigint;
  /** Ad spend for the campaign, BIGINT minor units. */
  spendMinor: bigint;
  /** attributed ÷ spend, 4dp string from exact operands; null when spend=0 (honest). */
  roasRatio: string | null;
}

interface CampaignAttrRow { campaign_id: string | null; currency_code: string; contribution_minor: string | number }
interface CampaignSpendRow { campaign_id: string | null; campaign_name: string | null; currency_code: string; spend_minor: string | number }

/**
 * computeCampaignRoas — per-campaign attributed-revenue ÷ ad-spend over [from, to].
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param params  - { model, fromDate, toDate } inclusive window.
 * @param deps    - The StarRocks Silver/Gold pool — gold_marketing_attribution + silver_marketing_spend.
 * @returns       One row per (campaign, currency) present on either side; roasRatio null when spend=0.
 */
export async function computeCampaignRoas(
  brandId: string,
  params: { model: AttributionModelId; fromDate: Date; toDate: Date },
  deps: { srPool: SilverPool; measurementMartsMigration?: boolean },
): Promise<CampaignRoasRow[]> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string; // Date-formatted → injection-safe
  const toStr = params.toDate.toISOString().split('T')[0] as string;
  // model is a typed AttributionModelId; guard to a safe identifier before interpolation.
  const model = /^[a-z0-9_]+$/i.test(params.model) ? params.model : '__invalid__';

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // Attributed revenue per (campaign, currency) — net of clawback (signed credited_revenue_minor).
    const attrRows = await scope.runScoped<CampaignAttrRow>(
      `SELECT campaign_id, currency_code, COALESCE(SUM(credited_revenue_minor), 0) AS contribution_minor
         FROM brain_serving.mv_gold_marketing_attribution
        WHERE model_id = '${model}'
          AND campaign_id IS NOT NULL
          AND CAST(economic_effective_at AS DATE) BETWEEN DATE '${fromStr}' AND DATE '${toStr}'
          AND ${BRAND_PREDICATE}
        GROUP BY campaign_id, currency_code`,
      [],
    );
    // Spend per (campaign, currency) — carries campaign_name for the label.
    const spendRows = await scope.runScoped<CampaignSpendRow>(
      `SELECT campaign_id, MAX(campaign_name) AS campaign_name, currency_code, SUM(spend_minor) AS spend_minor
         FROM ${spendView(deps.measurementMartsMigration)}
        WHERE campaign_id IS NOT NULL
          AND stat_date BETWEEN DATE '${fromStr}' AND DATE '${toStr}'
          -- GAP-C: the spend fact carries the SAME money at 'campaign', 'adset' AND 'ad' levels,
          -- and the child rows ALSO carry campaign_id — so a per-campaign GROUP BY without a level
          -- pin ~3×-counts each campaign's spend and deflates its ROAS. Pin to the canonical
          -- top-of-hierarchy 'campaign' level (mirrors gold_cac.py).
          AND level = 'campaign'
          AND ${BRAND_PREDICATE}
        GROUP BY campaign_id, currency_code`,
      [],
    );

    // key = `${campaignId}␟${currency}` — sum within the same (campaign, currency).
    const attributed = new Map<string, bigint>();
    for (const r of attrRows) {
      const key = `${r.campaign_id}␟${r.currency_code}`;
      attributed.set(key, (attributed.get(key) ?? 0n) + BigInt(String(r.contribution_minor).split('.')[0] ?? '0'));
    }
    const spend = new Map<string, bigint>();
    const names = new Map<string, string | null>();
    for (const r of spendRows) {
      const key = `${r.campaign_id}␟${r.currency_code}`;
      spend.set(key, (spend.get(key) ?? 0n) + BigInt(String(r.spend_minor).split('.')[0] ?? '0'));
      names.set(key, r.campaign_name ?? null);
    }

    const keys = new Set<string>([...attributed.keys(), ...spend.keys()]);
    const out: CampaignRoasRow[] = [];
    for (const key of keys) {
      const [campaignId, currencyCode] = key.split('␟') as [string, string];
      const attributedMinor = attributed.get(key) ?? 0n;
      const spendMinor = spend.get(key) ?? 0n;
      const roasRatio = spendMinor > 0n ? exactRatioString(attributedMinor, spendMinor) : null;
      out.push({
        campaignId,
        campaignName: names.get(key) ?? null,
        currencyCode,
        attributedMinor,
        spendMinor,
        roasRatio,
      });
    }

    out.sort((a, b) =>
      a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : a.currencyCode < b.currencyCode ? -1 : a.currencyCode > b.currencyCode ? 1 : 0,
    );
    return out;
  });
}
