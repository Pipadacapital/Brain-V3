/**
 * @brain/metric-engine — channel ROAS (per-channel attributed ÷ ad_spend, Tier-0).
 *
 * Makes blended_roas PER-CHANNEL: for each channel, ROAS = attributed_revenue ÷ ad_spend.
 *   • numerator   = channel_contribution_as_of(brand, model, from, to) — Σ credited_revenue
 *                   per channel (net of clawback), from the gold attribution credit ledger.
 *   • denominator = ad_spend_as_of(brand, from, to) — SUM(spend_minor) per (platform, currency),
 *                   mapped to the JourneyChannel via the platform→channel map.
 *
 * SAME-CURRENCY ONLY (mirrors blended_roas): ROAS is per currency_code, never blended
 * across currencies. HONEST: roasRatio is reported ONLY where spend>0; spend=0 → null
 * (never divide-by-zero, never a fabricated ∞). The two exact BIGINT operands are always
 * returned so the consumer re-derives the ratio exactly (no silent float rounding).
 *
 * ── PHASE G re-point: reads the lakehouse via withSilverBrand (I-ST01) — attributed revenue from
 *    brain_gold.gold_marketing_attribution (the channel_contribution_as_of math), spend from
 *    brain_silver.silver_marketing_spend (the ad_spend_as_of math). PG is no longer a read source.
 *
 * @see 05-architecture.md §6 (channel ROAS)
 * @see packages/metric-engine/src/blended-roas.ts (the blended sibling)
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
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

/**
 * Map an ad-spend platform to its JourneyChannel. The attribution ledger stores the
 * deterministic journey channel (paid_meta/paid_google/…); the ad_spend_ledger stores
 * the platform. This is the deterministic join key for per-channel ROAS.
 */
// Keys MUST be the real ad-spend platform literals (@brain/ad-spend-mapper AdPlatform =
// 'meta' | 'google_ads'). The previous 'google' key never matched the 'google_ads' spend literal,
// so Google spend fell through to 'paid' and Google per-channel ROAS was wrong (attributed
// paid_google revenue showed ∞/null ROAS with zero matched spend). 'tiktok' is forward-compat for
// when TikTok spend lands. A parity test asserts every AdPlatform literal has a mapping here.
const PLATFORM_TO_CHANNEL: Readonly<Record<string, string>> = {
  meta: 'paid_meta',
  google_ads: 'paid_google',
  tiktok: 'paid_tiktok',
} as const;

export function platformToChannel(platform: string): string {
  return PLATFORM_TO_CHANNEL[platform] ?? 'paid';
}

export interface ChannelRoasRow {
  channel: string;
  currencyCode: string;
  /** Attributed revenue for the channel (net of clawback), BIGINT minor units. */
  attributedMinor: bigint;
  /** Ad spend mapped to the channel, BIGINT minor units. */
  spendMinor: bigint;
  /** attributed ÷ spend, 4dp string from exact operands; null when spend=0 (honest). */
  roasRatio: string | null;
}

interface ChannelRow { channel: string; currency_code: string; contribution_minor: string | number }
interface SpendRow { platform: string; currency_code: string; spend_minor: string | number }

/**
 * computeChannelRoas — per-channel attributed-revenue ÷ ad-spend over [from, to].
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param params  - { model, fromDate, toDate } inclusive window.
 * @param deps    - The StarRocks Silver/Gold pool — gold_marketing_attribution + silver_marketing_spend.
 * @returns       One row per (channel, currency) present on either side; roasRatio null when spend=0.
 */
export async function computeChannelRoas(
  brandId: string,
  params: { model: AttributionModelId; fromDate: Date; toDate: Date },
  deps: { srPool: SilverPool },
): Promise<ChannelRoasRow[]> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string; // Date-formatted → injection-safe
  const toStr = params.toDate.toISOString().split('T')[0] as string;
  // model is a typed AttributionModelId; guard to a safe identifier before interpolation.
  const model = /^[a-z0-9_]+$/i.test(params.model) ? params.model : '__invalid__';

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // Attributed revenue per (channel, currency) — the channel_contribution_as_of math.
    const channelRows = await scope.runScoped<ChannelRow>(
      `SELECT channel, currency_code, COALESCE(SUM(credited_revenue_minor), 0) AS contribution_minor
         FROM brain_serving.mv_gold_marketing_attribution
        WHERE model_id = '${model}'
          AND CAST(economic_effective_at AS DATE) BETWEEN DATE '${fromStr}' AND DATE '${toStr}'
          AND ${BRAND_PREDICATE}
        GROUP BY channel, currency_code`,
      [],
    );
    // Spend per (platform, currency) — the ad_spend_as_of math.
    const spendRows = await scope.runScoped<SpendRow>(
      `SELECT platform, currency_code, SUM(spend_minor) AS spend_minor
         FROM brain_serving.mv_silver_marketing_spend
        WHERE stat_date BETWEEN DATE '${fromStr}' AND DATE '${toStr}'
          AND ${BRAND_PREDICATE}
        GROUP BY platform, currency_code`,
      [],
    );

    // key = `${channel}␟${currency}` — sum within the same (channel, currency).
    const attributed = new Map<string, bigint>();
    for (const r of channelRows) {
      const key = `${r.channel}␟${r.currency_code}`;
      attributed.set(key, (attributed.get(key) ?? 0n) + BigInt(String(r.contribution_minor).split('.')[0] ?? '0'));
    }
    const spend = new Map<string, bigint>();
    for (const r of spendRows) {
      const channel = platformToChannel(r.platform);
      const key = `${channel}␟${r.currency_code}`;
      spend.set(key, (spend.get(key) ?? 0n) + BigInt(String(r.spend_minor).split('.')[0] ?? '0'));
    }

    const keys = new Set<string>([...attributed.keys(), ...spend.keys()]);
    const out: ChannelRoasRow[] = [];
    for (const key of keys) {
      const [channel, currencyCode] = key.split('␟') as [string, string];
      const attributedMinor = attributed.get(key) ?? 0n;
      const spendMinor = spend.get(key) ?? 0n;
      const roasRatio = spendMinor > 0n ? exactRatioString(attributedMinor, spendMinor) : null;
      out.push({ channel, currencyCode, attributedMinor, spendMinor, roasRatio });
    }

    out.sort((a, b) =>
      a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : a.currencyCode < b.currencyCode ? -1 : a.currencyCode > b.currencyCode ? 1 : 0,
    );
    return out;
  });
}
