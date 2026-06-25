/**
 * @brain/metric-engine — computeRecognitionBreakdown
 *
 * Returns the distribution of revenue across recognition states:
 *   provisional → settling → finalized
 *
 * Groups ledger rows by recognition_label, summing amount_minor and counting distinct orders.
 * This is an aggregation on recognition_label (a ledger column), not an ad-hoc value computation —
 * it lives here in the metric engine (the sanctioned computation layer, ADR-002 / D-3).
 *
 * F-SEC-02: reads inside withBrandTxn (GUC transaction-scoped, RLS-enforced).
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export type RecognitionLabel = 'provisional' | 'settling' | 'finalized';

export interface RecognitionBreakdownItem {
  /** Recognition state label */
  label: RecognitionLabel;
  /** Total amount in minor units for this label (bigint) */
  amountMinor: bigint;
  /** Distinct order count in this label */
  count: bigint;
  /** ISO 4217 currency code */
  currency_code: string;
}

/**
 * computeRecognitionBreakdown — recognition state distribution as of a date.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param asOf    - Inclusive as-of date.
 * @param deps    - EngineDeps with raw pg.Pool.
 * @returns       Array of RecognitionBreakdownItem per (label, currency_code).
 *                Empty array when no ledger rows exist.
 */
export async function computeRecognitionBreakdown(
  brandId: string,
  asOf: Date,
  deps: { srPool: SilverPool },
): Promise<RecognitionBreakdownItem[]> {
  const asOfStr = asOf.toISOString().split('T')[0] as string;

  // MEDALLION REALIGNMENT (Epic 1): read brain_gold.gold_revenue_ledger via withSilverBrand, not PG.
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      recognition_label: string;
      currency_code: string;
      amount_minor: string | number;
      order_count: string | number;
    }>(
      `SELECT
         recognition_label,
         currency_code,
         SUM(amount_minor)        AS amount_minor,
         COUNT(DISTINCT order_id) AS order_count
       FROM brain_serving.mv_gold_revenue_ledger
       WHERE CAST(occurred_at AS DATE) <= ?
         AND recognition_label IS NOT NULL
         AND ${BRAND_PREDICATE}
       GROUP BY recognition_label, currency_code
       ORDER BY
         CASE recognition_label
           WHEN 'provisional' THEN 1
           WHEN 'settling'    THEN 2
           WHEN 'finalized'   THEN 3
           ELSE 4
         END,
         currency_code`,
      [asOfStr],
    );

    return rows.map((row) => ({
      label: row.recognition_label as RecognitionLabel,
      amountMinor: BigInt(String(row.amount_minor ?? '0').split('.')[0] || '0'),
      count: BigInt(String(row.order_count ?? '0').split('.')[0] || '0'),
      currency_code: row.currency_code,
    }));
  });
}
