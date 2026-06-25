/**
 * @brain/metric-engine — computeRevenueMonthly
 *
 * Returns the per-month revenue-lifecycle breakdown for a brand, read from the
 * Gold monthly mart brain_gold.gold_revenue_analytics. This is the sanctioned
 * computation layer (ADR-002 / D-3) — no ad-hoc SUM lives outside this package.
 *
 * gold_revenue_analytics is keyed by (brand_id, period_month, lifecycle_state,
 * currency_code) and already carries the heavy aggregation:
 *   - order_count          : orders that entered this lifecycle_state in the month
 *   - realized_value_minor  : recognized revenue minor units for the state (bigint)
 *   - terminal_order_count : orders that reached a terminal state (cancel/RTO/return)
 *
 * lifecycle_state is the order-spine recognition stage: 'placed' (provisional),
 * 'confirmed' (finalized/realized), 'cancelled' (terminal clawback). We surface the
 * raw rows per (month, state) so the BFF/UI can build the recognition funnel,
 * MoM growth, and net-realized series WITHOUT doing money math in the UI.
 *
 * Money is minor units + currency_code (I-S07). We NEVER blend currencies — each
 * row carries its own currency_code; aggregation is per (month, state, currency).
 *
 * @see brain_gold.gold_revenue_analytics (dbt mart)
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface RevenueMonthlyRow {
  /** Month key 'YYYY-MM' */
  period_month: string;
  /** Order-spine recognition stage: placed | confirmed | cancelled | ... */
  lifecycle_state: string;
  /** ISO 4217 currency code */
  currency_code: string;
  /** Orders in this (month, state) */
  orderCount: bigint;
  /** Recognized revenue minor units (bigint). 0 for non-realizing states. */
  realizedValueMinor: bigint;
  /** Orders that reached a terminal state in this (month, state) */
  terminalOrderCount: bigint;
}

/**
 * computeRevenueMonthly — per-month lifecycle revenue breakdown from the Gold mart.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param deps    - The StarRocks Silver/Gold pool ({ srPool }).
 * @returns       Array of RevenueMonthlyRow, ordered by month ASC then state.
 *                Empty array when the brand has no rows in the monthly mart.
 */
export async function computeRevenueMonthly(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<RevenueMonthlyRow[]> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      period_month: string;
      lifecycle_state: string;
      currency_code: string;
      order_count: string | number;
      realized_value_minor: string | number | null;
      terminal_order_count: string | number | null;
    }>(
      `SELECT
         period_month,
         lifecycle_state,
         currency_code,
         order_count,
         realized_value_minor,
         terminal_order_count
       FROM brain_gold.gold_revenue_analytics
       WHERE ${BRAND_PREDICATE}
       ORDER BY period_month ASC, lifecycle_state ASC, currency_code ASC`,
      [],
    );

    return rows.map((row) => ({
      period_month: row.period_month,
      lifecycle_state: row.lifecycle_state,
      currency_code: row.currency_code,
      orderCount: BigInt(String(row.order_count ?? '0').split('.')[0] || '0'),
      realizedValueMinor: BigInt(String(row.realized_value_minor ?? '0').split('.')[0] || '0'),
      terminalOrderCount: BigInt(String(row.terminal_order_count ?? '0').split('.')[0] || '0'),
    }));
  });
}
