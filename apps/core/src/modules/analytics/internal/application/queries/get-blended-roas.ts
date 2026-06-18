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
 * Honest-empty: state='no_data' ONLY when the brand has ZERO ad_spend_ledger rows.
 * Without spend there is no denominator → ROAS is undefined, so 'no_data' is the honest
 * surface (realized-only with no spend is not a ROAS).
 */

import type { EngineDeps } from '@brain/metric-engine';
import { computeBlendedRoas, withBrandTxn } from '@brain/metric-engine';

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
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getBlendedRoas(
  brandId: string,
  params: { fromDate: Date; toDate: Date },
  deps: EngineDeps,
): Promise<BlendedRoasResult> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const toStr = params.toDate.toISOString().split('T')[0] as string;

  // EXISTS on spend — ROAS requires a denominator. No spend → no_data (honest).
  const hasSpend = await withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ad_spend_ledger WHERE brand_id = $1) AS exists`,
      [brandId],
    );
    return r.rows[0]?.exists === true;
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
