/**
 * @brain/metric-engine — computeProvisionalRevenue (D-4, D-5)
 *
 * The SOLE emitter of provisional_revenue values for the DASHBOARD snapshot.
 *
 * ── PHASE G follow-up re-point: reads the lakehouse via withSilverBrand (I-ST01) — provisional from
 *    brain_gold.gold_revenue_ledger (the provisional_gmv_as_of math: per-currency SUM(amount_minor)
 *    over economic_effective_at ≤ as_of WHERE recognition_label IN ('provisional','settling')). The
 *    gold ledger carries ALL event types; the disjoint predicate keeps provisional separate from
 *    realized. No ad-hoc SUM in app code — the seam math, inlined here.
 *
 * Returns Map<CurrencyCode, bigint>: per-currency map.
 * NEVER blended into realized_revenue (disjoint predicates by design):
 *   realized:    event_type <> 'provisional_recognition'
 *   provisional: recognition_label IN ('provisional','settling')
 *
 * @see D-4, D-5 (03-architecture-plan.md)
 */

import type { CurrencyCode } from '@brain/money';
import type { SilverDeps } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/**
 * computeProvisionalRevenue — provisional revenue as of a date, per currency, from the lakehouse ledger.
 *
 * INVARIANT: provisional rows NEVER appear in the realized map (disjoint predicates).
 *
 * @param brandId - The brand UUID (from session — D-1).
 * @param asOf    - The as-of date (inclusive). economic_effective_at::date <= asOf.
 * @param deps    - The StarRocks Silver/Gold pool ({ srPool }).
 * @returns       Map<CurrencyCode, bigint> — provisional revenue per currency. Empty if 0 provisional.
 */
export async function computeProvisionalRevenue(
  brandId: string,
  asOf: Date,
  deps: SilverDeps,
): Promise<Map<CurrencyCode, bigint>> {
  const asOfStr = asOf.toISOString().split('T')[0] as string; // 'YYYY-MM-DD' — injection-safe

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // Provisional = per-currency SUM over recognition_label IN ('provisional','settling'), ≤ as_of.
    // Only currencies with provisional rows appear (GROUP BY) — matching the prior seam's TABLE shape.
    const rows = await scope.runScoped<{ currency_code: string; provisional_minor: string | number }>(
      `SELECT currency_code, COALESCE(SUM(amount_minor), 0) AS provisional_minor
         FROM brain_serving.mv_gold_revenue_ledger
        WHERE CAST(economic_effective_at AS DATE) <= '${asOfStr}'
          AND recognition_label IN ('provisional', 'settling')
          AND ${BRAND_PREDICATE}
        GROUP BY currency_code`,
      [],
    );

    const map = new Map<CurrencyCode, bigint>();
    for (const row of rows) {
      map.set(row.currency_code as CurrencyCode, BigInt(String(row.provisional_minor).split('.')[0] ?? '0'));
    }
    return map;
  });
}
