/**
 * @brain/metric-engine — computeBlendedRoas
 *
 * Blended ROAS = realized revenue ÷ ad spend, per currency_code, over [from, to].
 *
 * The metric engine is the SOLE sanctioned computation layer (ADR-002 / D-3).
 * Reads ONLY via the named DB seams — never an ad-hoc SUM:
 *   - numerator   = realized revenue WITHIN the window, derived from the EXISTING
 *                   realized_gmv_as_of(brand, date) seam (cumulative). Window-realized
 *                   = realized_gmv_as_of(to) − realized_gmv_as_of(from − 1 day). Both
 *                   operands are exact BIGINT (no float), so the difference is exact.
 *   - denominator = ad_spend_as_of(brand, from, to) — SUM(spend_minor) per
 *                   (platform, currency_code) over [from, to]. Summed across platforms
 *                   within the SAME currency to get total spend per currency.
 *
 * SAME-CURRENCY ONLY: ROAS is computed per currency_code and NEVER blended across
 * currencies (you cannot divide INR revenue by USD spend). Currencies present only on
 * the spend side (no realized) carry realized=0; currencies present only on the realized
 * side carry spend=0.
 *
 * HONEST: roasRatio is reported ONLY where spendMinor > 0. spend=0 → roasRatio = null
 * (never divide-by-zero, never a fabricated ∞ or 0). The two integer operands are always
 * returned so the consumer can re-derive the ratio exactly (no silent float rounding —
 * the ratio is formatted at the edge from the exact BIGINTs).
 *
 * F-SEC-02: all reads happen inside withBrandTxn so the GUC is transaction-scoped.
 * RLS scopes both ledgers to the active brand; both seams are SECURITY INVOKER.
 */

import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

export interface BlendedRoasRow {
  /** ISO 4217 currency code */
  currency_code: string;
  /** Realized revenue minor units within the window (BIGINT, exact) */
  realizedMinor: bigint;
  /** Ad spend minor units within the window (BIGINT, exact) */
  spendMinor: bigint;
  /**
   * realizedMinor / spendMinor as a decimal string with 4 fractional digits,
   * computed from the exact BIGINT operands (no float). null when spendMinor=0
   * (honest — no divide-by-zero). Consumers may also re-derive from the operands.
   */
  roasRatio: string | null;
}

/** Format an exact BIGINT ratio numerator/denominator to a fixed-precision decimal string. */
function exactRatioString(numerator: bigint, denominator: bigint, fractionalDigits = 4): string {
  // Scale numerator by 10^fractionalDigits, integer-divide, then place the decimal point.
  // All exact integer math — never IEEE float.
  const scale = 10n ** BigInt(fractionalDigits);
  const scaled = (numerator * scale) / denominator; // truncates toward zero (non-negative inputs)
  const intPart = scaled / scale;
  const fracPart = scaled % scale;
  const fracStr = fracPart.toString().padStart(fractionalDigits, '0');
  return `${intPart.toString()}.${fracStr}`;
}

/**
 * computeBlendedRoas — per-currency blended ROAS over [from, to].
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param params  - Inclusive date window { fromDate, toDate }.
 * @param deps    - EngineDeps with raw pg.Pool.
 * @returns       Array of BlendedRoasRow, one per currency_code present on either side.
 *                Empty array when neither realized nor spend rows exist in the window.
 */
export async function computeBlendedRoas(
  brandId: string,
  params: { fromDate: Date; toDate: Date },
  deps: EngineDeps,
): Promise<BlendedRoasRow[]> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const toStr = params.toDate.toISOString().split('T')[0] as string;

  // from − 1 day, for the cumulative-realized difference (window-realized).
  const fromMinus1 = new Date(params.fromDate.getTime() - 24 * 60 * 60 * 1000);
  const fromMinus1Str = fromMinus1.toISOString().split('T')[0] as string;

  return withBrandTxn(deps.pool, brandId, async (client) => {
    // ── Numerator: window-realized via the realized_gmv_as_of seam (no ad-hoc SUM) ──
    // realized_gmv_as_of returns a single scalar keyed to the brand's currency.
    // The brand row carries the authoritative currency_code (single-currency-per-brand
    // trigger, 0018). Window-realized = as_of(to) − as_of(from−1).
    const brandRow = await client.query<{ currency_code: string }>(
      `SELECT currency_code FROM brand WHERE id = $1`,
      [brandId],
    );
    const realizedCcy = brandRow.rows[0]?.currency_code ?? null;

    let realizedWindowMinor = 0n;
    if (realizedCcy !== null) {
      const realizedTo = await client.query<{ v: string }>(
        `SELECT realized_gmv_as_of($1::uuid, $2::date) AS v`,
        [brandId, toStr],
      );
      const realizedBefore = await client.query<{ v: string }>(
        `SELECT realized_gmv_as_of($1::uuid, $2::date) AS v`,
        [brandId, fromMinus1Str],
      );
      realizedWindowMinor =
        BigInt(realizedTo.rows[0]?.v ?? '0') - BigInt(realizedBefore.rows[0]?.v ?? '0');
      // Guard: realized is monotone non-decreasing in as_of, so the diff is >= 0; clamp
      // defensively (e.g. a late RTO reversal landing inside the window could net negative —
      // that is honest, keep it; do NOT clamp away a real reversal).
    }

    // ── Denominator: ad_spend_as_of seam, SUM per (platform, currency) over [from,to] ──
    const spendRows = await client.query<{
      platform: string;
      currency_code: string;
      spend_minor: string;
    }>(
      `SELECT platform, currency_code, spend_minor
         FROM ad_spend_as_of($1::uuid, $2::date, $3::date)`,
      [brandId, fromStr, toStr],
    );

    // Sum spend across platforms within the SAME currency.
    const spendByCcy = new Map<string, bigint>();
    for (const r of spendRows.rows) {
      const prev = spendByCcy.get(r.currency_code) ?? 0n;
      spendByCcy.set(r.currency_code, prev + BigInt(r.spend_minor));
    }

    // Assemble per-currency rows. Realized is single-currency (the brand currency); it only
    // contributes to its own currency. Spend may span currencies (one per ad account).
    const currencies = new Set<string>(spendByCcy.keys());
    if (realizedCcy !== null && realizedWindowMinor !== 0n) currencies.add(realizedCcy);

    const out: BlendedRoasRow[] = [];
    for (const ccy of currencies) {
      const realizedMinor = ccy === realizedCcy ? realizedWindowMinor : 0n;
      const spendMinor = spendByCcy.get(ccy) ?? 0n;
      // HONEST: ratio only where spend>0 (same currency, never blended cross-currency).
      const roasRatio = spendMinor > 0n ? exactRatioString(realizedMinor, spendMinor) : null;
      out.push({ currency_code: ccy, realizedMinor, spendMinor, roasRatio });
    }

    // Deterministic order.
    out.sort((a, b) => (a.currency_code < b.currency_code ? -1 : a.currency_code > b.currency_code ? 1 : 0));
    return out;
  });
}
