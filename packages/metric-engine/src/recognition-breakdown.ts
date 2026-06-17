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

import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

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
  deps: EngineDeps,
): Promise<RecognitionBreakdownItem[]> {
  const asOfStr = asOf.toISOString().split('T')[0];

  return withBrandTxn(deps.pool, brandId, async (client) => {
    // recognition_label is the canonical state column on the ledger.
    // We sum amount_minor and count distinct order_id per (recognition_label, currency_code).
    // Rows where recognition_label is NULL are excluded (should not exist by schema constraint).
    const sql = `
      SELECT
        recognition_label,
        currency_code,
        SUM(amount_minor)::text AS amount_minor,
        COUNT(DISTINCT order_id)::text AS order_count
      FROM realized_revenue_ledger
      WHERE brand_id = $1
        AND occurred_at::date <= $2::date
        AND recognition_label IS NOT NULL
      GROUP BY recognition_label, currency_code
      ORDER BY
        CASE recognition_label
          WHEN 'provisional' THEN 1
          WHEN 'settling'    THEN 2
          WHEN 'finalized'   THEN 3
          ELSE 4
        END,
        currency_code
    `;

    const result = await client.query<{
      recognition_label: string;
      currency_code: string;
      amount_minor: string;
      order_count: string;
    }>(sql, [brandId, asOfStr]);

    return result.rows.map((row) => ({
      label: row.recognition_label as RecognitionLabel,
      amountMinor: BigInt(row.amount_minor),
      count: BigInt(row.order_count),
      currency_code: row.currency_code,
    }));
  });
}
