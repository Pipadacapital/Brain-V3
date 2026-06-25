/**
 * getRecentActivity — bounded recent-rows read (D-2 allowed exception).
 *
 * Selects the latest N ledger rows inside withBrandTxn (RLS-scoped).
 * This is a bounded row-read, not a metric computation — explicitly permitted
 * by D-2 (like the EXISTS check pattern). It surfaces the raw event feed,
 * NOT computed aggregate values.
 *
 * Serializes amount_minor (BIGINT) → string for JSON safety (D-1).
 */

import type { SilverPool } from '@brain/metric-engine';
import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

/**
 * The full set of event_type values the realized-revenue ledger emits. The SELECT
 * below is unfiltered, so the feed surfaces ALL of them — not just the first three.
 * Kept as a widened string union (open-ended) so a newly-added ledger event_type
 * flows through honestly instead of being mistyped as one of the recognition states.
 */
export type LedgerEventType =
  | 'provisional_recognition'
  | 'finalization'
  | 'rto_reversal'
  | 'cod_delivery_confirmed'
  | 'cod_rto_clawback'
  | 'refund'
  | 'payment_fee'
  | 'settlement_finalization'
  | 'settlement_tax'
  | (string & {});

export interface RecentActivityRow {
  order_id: string;
  event_type: LedgerEventType;
  amount_minor: string;       // bigint → string
  currency_code: string;
  occurred_at: string;        // ISO timestamp string
  recognition_label: string | null;
}

export interface RecentActivityResult {
  rows: RecentActivityRow[];
}

/**
 * getRecentActivity — returns the latest N ledger rows for the brand.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param limit   - Max rows to return (capped at 50 server-side).
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getRecentActivity(
  brandId: string,
  limit: number,
  deps: { srPool: SilverPool },
): Promise<RecentActivityResult> {
  // Cap limit to prevent excessive reads
  const safeLimit = Math.min(Math.max(1, limit), 50);

  // V4 PHASE 4b: the recent-activity feed reads brain_serving.mv_gold_revenue_ledger via
  // withSilverBrand, not the PG ledger. Bounded row-read (D-2 allowed), brand-scoped at the seam.
  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    return scope.runScoped<{
      order_id: string;
      event_type: string;
      amount_minor: string | number;
      currency_code: string;
      occurred_at: string;
      recognition_label: string | null;
    }>(
      `SELECT order_id, event_type, amount_minor, currency_code, occurred_at, recognition_label
       FROM brain_serving.mv_gold_revenue_ledger
       WHERE ${BRAND_PREDICATE}
       ORDER BY occurred_at DESC
       LIMIT ${safeLimit}`,
      [],
    );
  });

  return {
    rows: rows.map((row) => ({
      order_id: row.order_id,
      event_type: row.event_type as RecentActivityRow['event_type'],
      amount_minor: String(row.amount_minor ?? '0').split('.')[0] || '0',
      currency_code: row.currency_code,
      occurred_at: new Date(row.occurred_at).toISOString(),
      recognition_label: row.recognition_label,
    })),
  };
}
