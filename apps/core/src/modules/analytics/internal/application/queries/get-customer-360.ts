/**
 * getCustomer360 — analytics use-case (ADR-002 sole-read-path, re-platform Phase E).
 *
 * @effort deterministic
 *
 * Thin wrapper around getCustomer360Summary (metric engine) over the gold_customer_360 mart. NO ad-hoc
 * aggregation — the engine owns it (D-3). Serializes bigint → string (D-1) and shapes the honest
 * no_data discriminant. brandId from session (D-1); the engine reads via withSilverBrand (I-ST01).
 *
 * @see packages/metric-engine/src/customer-360.ts
 */
import type { SilverPool } from '@brain/metric-engine';
import { getCustomer360Summary } from '@brain/metric-engine';

export interface Customer360RowDto {
  brain_id: string;
  lifetime_orders: string;
  lifetime_value_minor: string;
  delivered_orders: string;
  rto_orders: string;
}

export type Customer360Result =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      customer_count: string;
      total_lifetime_value_minor: string;
      total_lifetime_orders: string;
      currency_code: string | null;
      top_customers: Customer360RowDto[];
    };

export async function getCustomerBaseSummary(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<Customer360Result> {
  const r = await getCustomer360Summary(brandId, deps);
  if (!r.hasData) return { state: 'no_data' };
  return {
    state: 'has_data',
    customer_count: String(r.customerCount),
    total_lifetime_value_minor: String(r.totalLifetimeValueMinor),
    total_lifetime_orders: String(r.totalLifetimeOrders),
    currency_code: r.currencyCode,
    top_customers: r.topCustomers.map((c) => ({
      brain_id: c.brainId,
      lifetime_orders: String(c.lifetimeOrders),
      lifetime_value_minor: String(c.lifetimeValueMinor),
      delivered_orders: String(c.deliveredOrders),
      rto_orders: String(c.rtoOrders),
    })),
  };
}
