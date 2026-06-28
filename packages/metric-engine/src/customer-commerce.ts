/**
 * @brain/metric-engine — getCustomerCommerce (Customer-360 commerce profile)
 *
 * DB-AUDIT H7: "Customer 360" was identity-only — it assembled none of orders / LTV / lifecycle.
 * Now that C2 stamps brain_id on orders (so gold_customer_360 populates), this reader returns the
 * per-customer commerce profile (realized LTV, order counts, delivered/rto/cancelled/refunded
 * breakdown) from gold_customer_360, to be composed with the identity profile into the real 360.
 *
 * Reads the lakehouse via withSilverBrand (I-ST01) — per-brand isolation at the seam (BRAND_PREDICATE).
 * MONEY = BIGINT minor units + currency_code (I-S07). Returns null when the customer has no commerce
 * footprint yet (honest — an identity-only customer is valid).
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface CustomerCommerceProfile {
  brainId: string;
  currencyCode: string | null;
  lifetimeOrders: number;
  lifetimeValueMinor: bigint;
  deliveredOrders: number;
  rtoOrders: number;
  cancelledOrders: number;
  refundedOrders: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * getCustomerCommerce — the commerce half of Customer 360 for one brain_id.
 *
 * @param brandId - Brand UUID (from session — MT-1).
 * @param brainId - Identity-resolved customer key.
 * @param deps    - The StarRocks Gold pool (gold_customer_360).
 * @returns       The commerce profile, or null when the customer has no orders / invalid id.
 */
export async function getCustomerCommerce(
  brandId: string,
  brainId: string,
  deps: { srPool: SilverPool },
): Promise<CustomerCommerceProfile | null> {
  if (!UUID_RE.test(brainId)) return null;

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      currency_code: string | null;
      lifetime_orders: string | number;
      lifetime_value_minor: string | number;
      delivered_orders: string | number;
      rto_orders: string | number;
      cancelled_orders: string | number;
      refunded_orders: string | number;
      first_seen_at: string | null;
      last_seen_at: string | null;
    }>(
      `SELECT currency_code, lifetime_orders, lifetime_value_minor,
              delivered_orders, rto_orders, cancelled_orders, refunded_orders,
              CAST(first_seen_at AS VARCHAR) AS first_seen_at, CAST(last_seen_at AS VARCHAR) AS last_seen_at
         FROM brain_serving.mv_gold_customer_360
        WHERE brain_id = ? AND ${BRAND_PREDICATE}
        LIMIT 1`,
      [brainId],
    );
    const r = rows[0];
    if (!r) return null;
    const n = (v: string | number): number => Number(v ?? 0);
    return {
      brainId,
      currencyCode: r.currency_code ?? null,
      lifetimeOrders: n(r.lifetime_orders),
      lifetimeValueMinor: BigInt(String(r.lifetime_value_minor ?? '0').split('.')[0] ?? '0'),
      deliveredOrders: n(r.delivered_orders),
      rtoOrders: n(r.rto_orders),
      cancelledOrders: n(r.cancelled_orders),
      refundedOrders: n(r.refunded_orders),
      firstSeenAt: r.first_seen_at ?? null,
      lastSeenAt: r.last_seen_at ?? null,
    };
  });
}
