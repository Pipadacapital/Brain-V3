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

import type { EngineDeps } from '@brain/metric-engine';
import { withBrandTxn } from '@brain/metric-engine';

export interface RecentActivityRow {
  order_id: string;
  event_type: 'provisional_recognition' | 'finalization' | 'rto_reversal';
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
  deps: EngineDeps,
): Promise<RecentActivityResult> {
  // Cap limit to prevent excessive reads
  const safeLimit = Math.min(Math.max(1, limit), 50);

  const rows = await withBrandTxn(deps.pool, brandId, async (client) => {
    const result = await client.query<{
      order_id: string;
      event_type: string;
      amount_minor: string;
      currency_code: string;
      occurred_at: Date;
      recognition_label: string | null;
    }>(
      `SELECT order_id, event_type, amount_minor::text, currency_code,
              occurred_at, recognition_label
       FROM realized_revenue_ledger
       WHERE brand_id = $1
       ORDER BY occurred_at DESC
       LIMIT $2`,
      [brandId, safeLimit],
    );
    return result.rows;
  });

  return {
    rows: rows.map((row) => ({
      order_id: row.order_id,
      event_type: row.event_type as RecentActivityRow['event_type'],
      amount_minor: row.amount_minor,
      currency_code: row.currency_code,
      occurred_at: row.occurred_at.toISOString(),
      recognition_label: row.recognition_label,
    })),
  };
}
