/**
 * getRecognitionBreakdown — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin query wrapper around computeRecognitionBreakdown (metric engine).
 * Serializes bigint → string for JSON safety (D-1).
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeRecognitionBreakdown, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

export interface RecognitionBreakdownDto {
  label: 'provisional' | 'settling' | 'finalized';
  amount_minor: string;  // bigint → string
  count: string;         // bigint → string
  currency_code: string;
}

export type RecognitionBreakdownResult =
  | { state: 'no_data'; as_of: string }
  | { state: 'has_data'; as_of: string; breakdown: RecognitionBreakdownDto[] };

/**
 * getRecognitionBreakdown — returns recognition state distribution as of a date.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param asOf    - As-of date.
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getRecognitionBreakdown(
  brandId: string,
  asOf: Date,
  deps: { srPool: SilverPool },
): Promise<RecognitionBreakdownResult> {
  const asOfStr = asOf.toISOString().split('T')[0] as string;

  // EXISTS check (D-2) — over the lakehouse ledger (Epic 1).
  const hasData = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    const r = await scope.runScoped<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM brain_gold.gold_revenue_ledger WHERE ${BRAND_PREDICATE}`,
      [],
    );
    return Number(r[0]?.n ?? 0) > 0;
  });

  if (!hasData) {
    return { state: 'no_data', as_of: asOfStr };
  }

  const items = await computeRecognitionBreakdown(brandId, asOf, { srPool: deps.srPool });

  return {
    state: 'has_data',
    as_of: asOfStr,
    breakdown: items.map((item) => ({
      label: item.label,
      amount_minor: String(item.amountMinor),
      count: String(item.count),
      currency_code: item.currency_code,
    })),
  };
}
