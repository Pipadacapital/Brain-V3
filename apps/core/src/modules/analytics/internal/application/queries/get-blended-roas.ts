/**
 * getBlendedRoas — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin query wrapper around computeBlendedRoas (metric engine).
 * The engine is the SOLE computation layer — ROAS = realized_revenue ÷ ad_spend over the
 * window, per currency, SAME-CURRENCY ONLY, honest (spend=0 → roasRatio=null). No ad-hoc
 * arithmetic on money columns here (D-3); both operands come from named seams.
 *
 * Serializes bigint → string for JSON safety (D-1); roasRatio is the engine's exact
 * fixed-precision decimal string (or null).
 *
 * Honest-empty: state='no_data' ONLY when the brand has ZERO marketing-spend rows.
 * Without spend there is no denominator → ROAS is undefined, so 'no_data' is the honest
 * surface (realized-only with no spend is not a ROAS).
 *
 * V4 PHASE 4b: reads the serving mvs (mv_silver_marketing_spend + mv_gold_revenue_ledger) via
 * withSilverBrand — PG ad_spend_ledger / realized_revenue_ledger are no longer read sources.
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeBlendedRoas, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

export interface BlendedRoasDto {
  currency_code: string;
  realized_minor: string;   // bigint serialized (D-1)
  spend_minor: string;      // bigint serialized (D-1)
  roas_ratio: string | null; // exact decimal string, or null when spend=0 (honest)
}

export type BlendedRoasResult =
  | { state: 'no_data'; from: string; to: string }
  | { state: 'has_data'; from: string; to: string; rows: BlendedRoasDto[] };

/**
 * getBlendedRoas — returns per-currency blended ROAS over [from, to].
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param params  - Inclusive date window { fromDate, toDate }.
 * @param deps    - The StarRocks Silver/Gold pool — silver_marketing_spend + gold_revenue_ledger.
 */
export async function getBlendedRoas(
  brandId: string,
  params: { fromDate: Date; toDate: Date },
  // SPEC:C.4 — measurementMartsMigration threads the marts-migration flag to the spend read (default OFF → legacy view).
  deps: { srPool: SilverPool; measurementMartsMigration?: boolean },
): Promise<BlendedRoasResult> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const toStr = params.toDate.toISOString().split('T')[0] as string;

  // EXISTS on spend — ROAS requires a denominator. No spend → no_data (honest).
  // Reads the lakehouse Silver entity through the brand-scoped seam (BRAND_PREDICATE → brand_id = ?).
  const hasSpend = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    const r = await scope.runScoped<{ has_row: number }>(
      `SELECT 1 AS has_row FROM brain_serving.mv_silver_marketing_spend WHERE ${BRAND_PREDICATE} LIMIT 1`,
      [],
    );
    return r.length > 0;
  });

  if (!hasSpend) {
    return { state: 'no_data', from: fromStr, to: toStr };
  }

  const rows = await computeBlendedRoas(brandId, params, deps);

  return {
    state: 'has_data',
    from: fromStr,
    to: toStr,
    rows: rows.map((r) => ({
      currency_code: r.currency_code,
      realized_minor: String(r.realizedMinor),
      spend_minor: String(r.spendMinor),
      roas_ratio: r.roasRatio,
    })),
  };
}
