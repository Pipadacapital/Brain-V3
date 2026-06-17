/**
 * getRecognitionBreakdown — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin query wrapper around computeRecognitionBreakdown (metric engine).
 * Serializes bigint → string for JSON safety (D-1).
 */

import type { EngineDeps } from '@brain/metric-engine';
import { computeRecognitionBreakdown, withBrandTxn } from '@brain/metric-engine';

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
  deps: EngineDeps,
): Promise<RecognitionBreakdownResult> {
  const asOfStr = asOf.toISOString().split('T')[0] as string;

  // EXISTS check (D-2)
  const hasData = await withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM realized_revenue_ledger WHERE brand_id = $1) AS exists`,
      [brandId],
    );
    return r.rows[0]?.exists === true;
  });

  if (!hasData) {
    return { state: 'no_data', as_of: asOfStr };
  }

  const items = await computeRecognitionBreakdown(brandId, asOf, deps);

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
