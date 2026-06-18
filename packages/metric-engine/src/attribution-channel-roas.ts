/**
 * @brain/metric-engine — channel ROAS (per-channel attributed ÷ ad_spend, Tier-0).
 *
 * Makes blended_roas PER-CHANNEL: for each channel, ROAS = attributed_revenue ÷ ad_spend.
 *   • numerator   = channel_contribution_as_of(brand, model, from, to) — Σ credited_revenue
 *                   per channel (net of clawback), from attribution_credit_ledger.
 *   • denominator = ad_spend_as_of(brand, from, to) — SUM(spend_minor) per (platform, currency),
 *                   mapped to the JourneyChannel via the platform→channel map.
 *
 * SAME-CURRENCY ONLY (mirrors blended_roas): ROAS is per currency_code, never blended
 * across currencies. HONEST: roasRatio is reported ONLY where spend>0; spend=0 → null
 * (never divide-by-zero, never a fabricated ∞). The two exact BIGINT operands are always
 * returned so the consumer re-derives the ratio exactly (no silent float rounding).
 *
 * F-SEC-02: reads inside withBrandTxn (GUC transaction-scoped); seams SECURITY INVOKER.
 *
 * @see 05-architecture.md §6 (channel ROAS)
 * @see packages/metric-engine/src/blended-roas.ts (the blended sibling)
 */

import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';
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
const PLATFORM_TO_CHANNEL: Readonly<Record<string, string>> = {
  meta: 'paid_meta',
  google: 'paid_google',
  tiktok: 'paid_tiktok',
} as const;

function platformToChannel(platform: string): string {
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

interface ChannelRow { channel: string; currency_code: string; contribution_minor: string }
interface SpendRow { platform: string; currency_code: string; spend_minor: string }

/**
 * computeChannelRoas — per-channel attributed-revenue ÷ ad-spend over [from, to].
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param params  - { model, fromDate, toDate } inclusive window.
 * @param deps    - EngineDeps with the pg.Pool.
 * @returns       One row per (channel, currency) present on either side; roasRatio null when spend=0.
 */
export async function computeChannelRoas(
  brandId: string,
  params: { model: AttributionModelId; fromDate: Date; toDate: Date },
  deps: EngineDeps,
): Promise<ChannelRoasRow[]> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const toStr = params.toDate.toISOString().split('T')[0] as string;

  return withBrandTxn(deps.pool, brandId, async (client) => {
    const channelRows = await client.query<ChannelRow>(
      `SELECT channel, currency_code, contribution_minor
         FROM channel_contribution_as_of($1::uuid, $2::text, $3::date, $4::date)`,
      [brandId, params.model, fromStr, toStr],
    );
    const spendRows = await client.query<SpendRow>(
      `SELECT platform, currency_code, spend_minor
         FROM ad_spend_as_of($1::uuid, $2::date, $3::date)`,
      [brandId, fromStr, toStr],
    );

    // key = `${channel}␟${currency}` — sum within the same (channel, currency).
    const attributed = new Map<string, bigint>();
    for (const r of channelRows.rows) {
      const key = `${r.channel}␟${r.currency_code}`;
      attributed.set(key, (attributed.get(key) ?? 0n) + BigInt(r.contribution_minor));
    }
    const spend = new Map<string, bigint>();
    for (const r of spendRows.rows) {
      const channel = platformToChannel(r.platform);
      const key = `${channel}␟${r.currency_code}`;
      spend.set(key, (spend.get(key) ?? 0n) + BigInt(r.spend_minor));
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
