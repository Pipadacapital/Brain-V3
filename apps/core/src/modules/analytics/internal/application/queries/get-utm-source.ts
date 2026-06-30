/**
 * getUtmSource — analytics use-case (ADR-002 sole-read-path) for the P3 UTM / acquisition-source matrix.
 *
 * The source/medium matrix over the Gold mart gold_utm_source, via computeUtmSource (metric engine)
 * through the withSilverBrand seam (I-ST01 — the engine is the sole Gold reader; the UI never queries
 * the lakehouse directly). One row per first-touch (source, medium): visitors, conversions,
 * revenue_minor, avg_ltv_minor, repeat_rate_pct, currency_code. NO ad-hoc arithmetic (D-3); the mart
 * computes every measure. Honest no_data when the brand has no acquisition rows.
 *
 * MONEY (I-S07): revenue_minor + avg_ltv_minor are bigint MINOR units serialized to string (D-1),
 * paired with the row's sibling currency_code — never blended across currencies. repeat_rate_pct is a
 * NON-money integer 0-100. brandId from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/utm-source.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeUtmSource } from '@brain/metric-engine';

export interface UtmSourceRowDto {
  source: string;
  medium: string;
  visitors: string; // bigint → string
  conversions: string; // bigint → string
  revenue_minor: string; // bigint MINOR units → string (paired with currency_code)
  avg_ltv_minor: string; // bigint MINOR units → string (same currency_code)
  repeat_rate_pct: number; // integer 0-100 (NON-money)
  currency_code: string | null;
}

export type UtmSourceResult =
  | { state: 'no_data'; generated_at: string }
  | { state: 'has_data'; rows: UtmSourceRowDto[]; generated_at: string };

/**
 * getUtmSource — a brand's UTM / acquisition-source matrix.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Trino Gold serving pool (mv_gold_utm_source).
 */
export async function getUtmSource(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<UtmSourceResult> {
  // served_at: honest server compute time for this read (the FreshnessBadge shows a real relative time).
  const generatedAt = new Date().toISOString();
  const result = await computeUtmSource(brandId, deps);

  if (!result.hasData) {
    return { state: 'no_data', generated_at: generatedAt };
  }

  return {
    state: 'has_data',
    generated_at: generatedAt,
    rows: result.rows.map((r) => ({
      source: r.source,
      medium: r.medium,
      visitors: String(r.visitors),
      conversions: String(r.conversions),
      revenue_minor: String(r.revenueMinor),
      avg_ltv_minor: String(r.avgLtvMinor),
      repeat_rate_pct: r.repeatRatePct,
      currency_code: r.currencyCode,
    })),
  };
}
