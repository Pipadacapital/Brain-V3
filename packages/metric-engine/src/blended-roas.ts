/**
 * @brain/metric-engine — computeBlendedRoas
 *
 * Blended ROAS = realized revenue ÷ ad spend, per currency_code, over [from, to].
 *
 * The metric engine is the SOLE sanctioned computation layer (ADR-002 / D-3).
 *   - numerator   = realized revenue WITHIN the window. realized_gmv_as_of(brand, date)
 *                   (0018) = SUM(amount_minor) WHERE economic_effective_at::date <= date
 *                   AND event_type <> 'provisional_recognition'. So window-realized = the
 *                   same SUM restricted to economic_effective_at::date ∈ [from, to] — exact BIGINT.
 *   - denominator = SUM(spend_minor) per currency_code over stat_date ∈ [from, to], summed
 *                   across platforms within the SAME currency to get total spend per currency.
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
 * ── PHASE G re-point: reads the lakehouse via withSilverBrand (I-ST01) — realized from
 *    brain_gold.gold_revenue_ledger, spend from brain_silver.silver_marketing_spend. PG is no
 *    longer a read source for either (write SoR only). Per-brand isolation at the seam (BRAND_PREDICATE).
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
import { spendView } from './measurement-migration.js';

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
 * @param deps    - The StarRocks Silver/Gold pool — gold_revenue_ledger + silver_marketing_spend.
 * @returns       Array of BlendedRoasRow, one per currency_code present on either side.
 *                Empty array when neither realized nor spend rows exist in the window.
 */
export async function computeBlendedRoas(
  brandId: string,
  params: { fromDate: Date; toDate: Date },
  deps: { srPool: SilverPool; measurementMartsMigration?: boolean },
): Promise<BlendedRoasRow[]> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string; // Date-formatted → injection-safe
  const toStr = params.toDate.toISOString().split('T')[0] as string;

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ── Numerator: window-realized from the lakehouse ledger (the realized_gmv_as_of math) ──
    // SUM(amount_minor) over economic_effective_at ∈ [from, to], excluding provisional rows.
    // currency_code is single-per-brand (0018 trigger) — carried on the rows.
    const realizedRows = await scope.runScoped<{ v: string | number; currency_code: string | null }>(
      `SELECT COALESCE(SUM(amount_minor), 0) AS v, MAX(currency_code) AS currency_code
         FROM brain_serving.mv_gold_revenue_ledger
        WHERE CAST(economic_effective_at AS DATE) BETWEEN DATE '${fromStr}' AND DATE '${toStr}'
          AND event_type <> 'provisional_recognition'
          AND ${BRAND_PREDICATE}`,
      [],
    );
    const realizedCcy = realizedRows[0]?.currency_code ?? null;
    // Keep a real reversal honest (do NOT clamp a net-negative window away).
    const realizedWindowMinor =
      realizedCcy !== null ? BigInt(String(realizedRows[0]?.v ?? '0').split('.')[0] ?? '0') : 0n;

    // ── Denominator: spend per (platform, currency) over stat_date ∈ [from, to] ──
    const spendRows = await scope.runScoped<{
      platform: string;
      currency_code: string;
      spend_minor: string | number;
    }>(
      `SELECT platform, currency_code, SUM(spend_minor) AS spend_minor
         FROM ${spendView(deps.measurementMartsMigration)}
        WHERE stat_date BETWEEN DATE '${fromStr}' AND DATE '${toStr}'
          AND ${BRAND_PREDICATE}
        GROUP BY platform, currency_code`,
      [],
    );

    // Sum spend across platforms within the SAME currency.
    const spendByCcy = new Map<string, bigint>();
    for (const r of spendRows) {
      const prev = spendByCcy.get(r.currency_code) ?? 0n;
      spendByCcy.set(r.currency_code, prev + BigInt(String(r.spend_minor).split('.')[0] ?? '0'));
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
