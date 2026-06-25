/**
 * getRevenueMonthly — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin query wrapper around computeRevenueMonthly (metric engine). Reads the Gold
 * monthly mart brain_serving.mv_gold_revenue_analytics for the per-month revenue-lifecycle
 * breakdown (placed → confirmed → cancelled with realized value + order/terminal
 * counts). The engine is the SOLE computation layer (D-3); this wrapper only
 * serializes bigint → string (D-1) and applies the honest-empty state (D-2).
 *
 * The UI builds MoM growth / recognition funnel / net-realized from these rows —
 * no money math in the UI; the read returns the numbers (per currency, never blended).
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeRevenueMonthly, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

export interface RevenueMonthlyRowDto {
  period_month: string;          // 'YYYY-MM'
  lifecycle_state: string;       // placed | confirmed | cancelled | ...
  currency_code: string;
  order_count: string;           // bigint → string
  realized_value_minor: string;  // bigint → string (minor units)
  terminal_order_count: string;  // bigint → string
}

export type RevenueMonthlyResult =
  | { state: 'no_data' }
  | { state: 'has_data'; rows: RevenueMonthlyRowDto[] };

/**
 * getRevenueMonthly — per-month lifecycle revenue breakdown for a brand.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param deps    - StarRocks Silver/Gold pool ({ srPool }).
 */
export async function getRevenueMonthly(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<RevenueMonthlyResult> {
  // EXISTS check (D-2) over the monthly Gold mart — authoritative honest-empty.
  const hasData = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    const r = await scope.runScoped<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM brain_serving.mv_gold_revenue_analytics WHERE ${BRAND_PREDICATE}`,
      [],
    );
    return Number(r[0]?.n ?? 0) > 0;
  });

  if (!hasData) {
    return { state: 'no_data' };
  }

  const rows = await computeRevenueMonthly(brandId, { srPool: deps.srPool });

  return {
    state: 'has_data',
    rows: rows.map((r) => ({
      period_month: r.period_month,
      lifecycle_state: r.lifecycle_state,
      currency_code: r.currency_code,
      order_count: String(r.orderCount),
      realized_value_minor: String(r.realizedValueMinor),
      terminal_order_count: String(r.terminalOrderCount),
    })),
  };
}
