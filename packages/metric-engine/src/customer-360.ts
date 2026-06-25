/**
 * @brain/metric-engine — getCustomer360Summary (re-platform Phase E).
 *
 * The SOLE read seam for the Customer-360 Gold mart (brain_gold.gold_customer_360) — read through
 * withSilverBrand (brand predicate injected at the seam, I-ST01; the engine is the only Gold reader,
 * the UI never queries StarRocks). Returns a brand's customer-base summary + top customers by value.
 *
 * MONEY = BIGINT minor units (I-S07). Honest-empty: hasData=false when the brand has no customers.
 * @see packages/metric-engine/src/cod-rto-rates.ts (sibling Gold/Silver read) + silver-deps.ts (seam)
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface Customer360Row {
  brainId: string;
  lifetimeOrders: bigint;
  lifetimeValueMinor: bigint;
  deliveredOrders: bigint;
  rtoOrders: bigint;
  /** H6: acquisition time — when this customer first attached a strong identifier. Null = anon-only. */
  firstIdentifiedAt: string | null;
}

export interface Customer360Summary {
  hasData: boolean;
  customerCount: bigint;
  totalLifetimeValueMinor: bigint;
  totalLifetimeOrders: bigint;
  currencyCode: string | null;
  /** Top customers by lifetime value (desc), capped. */
  topCustomers: Customer360Row[];
}

const TOP_N = 10;

export async function getCustomer360Summary(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<Customer360Summary> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const summaryRows = await scope.runScoped<{
      customer_count: string | number;
      total_value: string | number;
      total_orders: string | number;
      currency_code: string | null;
    }>(
      `SELECT COUNT(*)                                  AS customer_count,
              COALESCE(SUM(lifetime_value_minor), 0)    AS total_value,
              COALESCE(SUM(lifetime_orders), 0)         AS total_orders,
              MAX(currency_code)                        AS currency_code
         FROM brain_serving.mv_gold_customer_360
        WHERE ${BRAND_PREDICATE}`,
      [],
    );

    const s = summaryRows[0];
    const customerCount = BigInt(String(s?.customer_count ?? '0'));
    if (customerCount === 0n) {
      return {
        hasData: false,
        customerCount: 0n,
        totalLifetimeValueMinor: 0n,
        totalLifetimeOrders: 0n,
        currencyCode: null,
        topCustomers: [],
      };
    }

    const topRows = await scope.runScoped<{
      brain_id: string;
      lifetime_orders: string | number;
      lifetime_value_minor: string | number;
      delivered_orders: string | number;
      rto_orders: string | number;
      first_identified_at: string | null;
    }>(
      `SELECT brain_id, lifetime_orders, lifetime_value_minor, delivered_orders, rto_orders,
              first_identified_at
         FROM brain_serving.mv_gold_customer_360
        WHERE ${BRAND_PREDICATE}
        ORDER BY lifetime_value_minor DESC
        LIMIT ${TOP_N}`,
      [],
    );

    return {
      hasData: true,
      customerCount,
      totalLifetimeValueMinor: BigInt(String(s?.total_value ?? '0').split('.')[0] ?? '0'),
      totalLifetimeOrders: BigInt(String(s?.total_orders ?? '0')),
      currencyCode: s?.currency_code ?? null,
      topCustomers: topRows.map((r) => ({
        brainId: r.brain_id,
        lifetimeOrders: BigInt(String(r.lifetime_orders)),
        lifetimeValueMinor: BigInt(String(r.lifetime_value_minor)),
        deliveredOrders: BigInt(String(r.delivered_orders)),
        rtoOrders: BigInt(String(r.rto_orders)),
        firstIdentifiedAt: r.first_identified_at ?? null,
      })),
    };
  });
}
