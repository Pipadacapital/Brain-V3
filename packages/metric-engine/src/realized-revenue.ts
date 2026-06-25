/**
 * @brain/metric-engine — computeRealizedRevenue (D-5)
 *
 * The SOLE emitter of realized_revenue values for the DASHBOARD snapshot.
 *
 * ── PHASE G follow-up re-point: reads the lakehouse via withSilverBrand (I-ST01) — realized from
 *    brain_gold.gold_revenue_ledger (the realized_gmv_as_of math: SUM(amount_minor) over
 *    economic_effective_at ≤ as_of, excluding provisional_recognition). This completes PG-operational-
 *    only for the dashboard read path; the dashboard revenue snapshot now reads the same lakehouse copy
 *    as every other dashboard metric. PG's realized_gmv_as_of() seam REMAINS the source for BILLING
 *    (seal-billing-period reads billing.realized_revenue_ledger directly — invoicing must seal off the
 *    write SoR, never a lagged derived copy). No ad-hoc SUM in app code — the seam math, inlined here.
 *
 * Returns Map<CurrencyCode, bigint>: per-currency map (M1: 1 entry per brand, single-currency trigger).
 *
 * @see D-5 (03-architecture-plan.md)
 */

import type { CurrencyCode } from '@brain/money';
import type { SilverDeps } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/**
 * computeRealizedRevenue — realized revenue as of a date, per currency, from the lakehouse gold ledger.
 *
 * currency_code is single-per-brand (0018 trigger); the key is taken from MAX(currency_code) over the
 * brand's rows so the map carries the currency even when realized is a true 0 (brand has only
 * provisional rows in the window) — honest, matching the prior seam behaviour.
 *
 * @param brandId - The brand UUID (from session — D-1).
 * @param asOf    - The as-of date (inclusive). economic_effective_at::date <= asOf.
 * @param deps    - The StarRocks Silver/Gold pool ({ srPool }).
 * @returns       Map<CurrencyCode, bigint> — realized revenue per currency. bigint minor units (I-S07).
 */
export async function computeRealizedRevenue(
  brandId: string,
  asOf: Date,
  deps: SilverDeps,
): Promise<Map<CurrencyCode, bigint>> {
  const asOfStr = asOf.toISOString().split('T')[0] as string; // 'YYYY-MM-DD' — injection-safe

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // realized = SUM(amount_minor) over economic_effective_at ≤ as_of, excluding provisional. The
    // currency key comes from any of the brand's rows (so realized=0 still carries its currency).
    const rows = await scope.runScoped<{ v: string | number; currency_code: string | null }>(
      `SELECT
         COALESCE(SUM(CASE
           WHEN CAST(economic_effective_at AS DATE) <= '${asOfStr}'
            AND event_type <> 'provisional_recognition'
           THEN amount_minor ELSE 0 END), 0) AS v,
         MAX(currency_code) AS currency_code
       FROM brain_serving.mv_gold_revenue_ledger
       WHERE ${BRAND_PREDICATE}`,
      [],
    );

    const currencyCode = (rows[0]?.currency_code ?? null) as CurrencyCode | null;
    const map = new Map<CurrencyCode, bigint>();
    if (currencyCode === null) {
      // Brand has no ledger rows (or Silver unavailable) → empty map (fail-closed, honest).
      return map;
    }
    // Keep a true reversal honest (do NOT clamp a net-negative window).
    map.set(currencyCode, BigInt(String(rows[0]?.v ?? '0').split('.')[0] ?? '0'));
    return map;
  });
}
