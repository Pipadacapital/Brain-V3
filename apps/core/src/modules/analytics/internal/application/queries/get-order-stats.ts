/**
 * getOrderStats — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin query wrapper around computeOrderStats (metric engine).
 * Serializes bigint → string for JSON safety (D-1).
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeOrderStats, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

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
  deps: { srPool: SilverPool },
): Promise<OrderStatsResult> {
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

  const stats = await computeOrderStats(brandId, asOf, { srPool: deps.srPool });

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
