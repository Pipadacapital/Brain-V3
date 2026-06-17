/**
 * getOrderStats — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin query wrapper around computeOrderStats (metric engine).
 * Serializes bigint → string for JSON safety (D-1).
 */

import type { EngineDeps } from '@brain/metric-engine';
import { computeOrderStats, withBrandTxn } from '@brain/metric-engine';

export interface OrderStatsDto {
  currency_code: string;
  order_count: string;   // bigint → string
  aov_minor: string;     // bigint → string
  rto_rate_pct: string;  // numeric string e.g. '3.25'
}

export type OrderStatsResult =
  | { state: 'no_data'; as_of: string }
  | { state: 'has_data'; as_of: string; stats: OrderStatsDto[] };

/**
 * getOrderStats — returns per-currency order stats snapshot as of a date.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param asOf    - As-of date.
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getOrderStats(
  brandId: string,
  asOf: Date,
  deps: EngineDeps,
): Promise<OrderStatsResult> {
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

  const stats = await computeOrderStats(brandId, asOf, deps);

  return {
    state: 'has_data',
    as_of: asOfStr,
    stats: stats.map((s) => ({
      currency_code: s.currency_code,
      order_count: String(s.orderCount),
      aov_minor: String(s.aovMinor),
      rto_rate_pct: s.rtoRatePct,
    })),
  };
}
