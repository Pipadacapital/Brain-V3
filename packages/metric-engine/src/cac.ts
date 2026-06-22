/**
 * @brain/metric-engine — computeCac (Customer Acquisition Cost)
 *
 * CAC = acquisition spend ÷ newly-acquired customers, per currency_code, over an acquisition-month
 * window. DB-AUDIT: CAC previously had NO supporting model; gold_cac now joins ad spend to first-order
 * customers, and this is the SOLE sanctioned CAC computation (ADR-002 / metric-engine-only).
 *
 *   - numerator   = SUM(acquisition_spend_minor) over acquisition_month ∈ [from, to] (BIGINT, exact).
 *   - denominator = SUM(new_customers) over the same window (customers whose first order fell in-month).
 *
 * SAME-CURRENCY ONLY: CAC is per currency_code, never blended across currencies. HONEST: cacMinor is
 * reported ONLY where new_customers > 0; 0 new customers → cacMinor = null (never divide-by-zero, never
 * a fabricated ∞). The integer operands are always returned so the consumer can re-derive exactly.
 *
 * Reads the lakehouse via withSilverBrand (I-ST01) — brain_gold.gold_cac. Per-brand isolation at the
 * seam (BRAND_PREDICATE). MONEY = BIGINT minor units paired with currency_code (I-S07).
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface CacRow {
  /** ISO 4217 currency code. */
  currency_code: string;
  /** Newly-acquired customers in the window (first order in-month). */
  newCustomers: number;
  /** Acquisition ad spend minor units in the window (BIGINT, exact). */
  acquisitionSpendMinor: bigint;
  /**
   * acquisitionSpendMinor / newCustomers as a 4dp decimal string of MINOR units, from the exact
   * integer operands (no float). null when newCustomers=0 (honest — no divide-by-zero). Consumers
   * may also re-derive from the operands.
   */
  cacMinor: string | null;
}

/** Format an exact integer ratio numerator/denominator to a fixed-precision decimal string. */
function exactRatioString(numerator: bigint, denominator: bigint, fractionalDigits = 4): string {
  const scale = 10n ** BigInt(fractionalDigits);
  const scaled = (numerator * scale) / denominator; // truncates toward zero (non-negative inputs)
  const intPart = scaled / scale;
  const fracPart = scaled % scale;
  return `${intPart.toString()}.${fracPart.toString().padStart(fractionalDigits, '0')}`;
}

/**
 * computeCac — per-currency CAC over an acquisition-month window [from, to].
 *
 * @param brandId - Brand UUID (from session — MT-1).
 * @param params  - Inclusive date window { fromDate, toDate } (truncated to acquisition months).
 * @param deps    - The StarRocks Silver/Gold pool (gold_cac).
 * @returns       One CacRow per currency_code present in the window; [] when none.
 */
export async function computeCac(
  brandId: string,
  params: { fromDate: Date; toDate: Date },
  deps: { srPool: SilverPool },
): Promise<CacRow[]> {
  // YYYY-MM month bounds (gold_cac.acquisition_month is a 'YYYY-MM' string). Date-formatted →
  // injection-safe (no user text reaches the SQL).
  const fromMonth = params.fromDate.toISOString().slice(0, 7);
  const toMonth = params.toDate.toISOString().slice(0, 7);

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      currency_code: string;
      new_customers: string | number;
      acquisition_spend_minor: string | number;
    }>(
      `SELECT currency_code,
              SUM(new_customers)            AS new_customers,
              SUM(acquisition_spend_minor)  AS acquisition_spend_minor
         FROM brain_gold.gold_cac
        WHERE acquisition_month BETWEEN '${fromMonth}' AND '${toMonth}'
          AND ${BRAND_PREDICATE}
        GROUP BY currency_code`,
      [],
    );

    const out: CacRow[] = rows.map((r) => {
      const newCustomers = Number(r.new_customers ?? 0);
      const acquisitionSpendMinor = BigInt(String(r.acquisition_spend_minor ?? '0').split('.')[0] ?? '0');
      const cacMinor = newCustomers > 0 ? exactRatioString(acquisitionSpendMinor, BigInt(newCustomers)) : null;
      return { currency_code: r.currency_code, newCustomers, acquisitionSpendMinor, cacMinor };
    });

    out.sort((a, b) => (a.currency_code < b.currency_code ? -1 : a.currency_code > b.currency_code ? 1 : 0));
    return out;
  });
}
