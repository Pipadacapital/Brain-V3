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
  /** Public 'BRN-…' reference derived from brainId (deterministic, 1:1). What the UI shows instead of the UUID. */
  customerRef: string | null;
  lifetimeOrders: bigint;
  lifetimeValueMinor: bigint;
  /** B2: average order value in bigint MINOR units (same currencyCode), exact integer division. Null = 0 orders. */
  aovMinor: bigint | null;
  deliveredOrders: bigint;
  rtoOrders: bigint;
  /** H6: acquisition time — when this customer first attached a strong identifier. Null = anon-only. */
  firstIdentifiedAt: string | null;
  /** B2 enrichment, folded onto the Customer360 row by gold_customer_360. Null = no source signal. */
  preferredChannel: string | null;
  preferredDevice: string | null;
  topCategory: string | null;
  acquisitionSource: string | null;
  healthBand: string | null;
  /** Churn-risk INTEGER 0-100 — NOT money, NOT confidence. Null = no scores row yet. */
  churnScore: number | null;
  lifecycleStage: string | null;
  /** ISO-8601 timestamp of the most recent observed activity. Null = never observed. */
  lastActivityAt: string | null;
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
      customer_ref: string | null;
      lifetime_orders: string | number;
      lifetime_value_minor: string | number;
      aov_minor: string | number | null;
      delivered_orders: string | number;
      rto_orders: string | number;
      first_identified_at: string | null;
      preferred_channel: string | null;
      preferred_device: string | null;
      top_category: string | null;
      acquisition_source: string | null;
      health_band: string | null;
      churn_score: string | number | null;
      lifecycle_stage: string | null;
      last_activity_at: string | null;
    }>(
      `SELECT brain_id, customer_ref, lifetime_orders, lifetime_value_minor, aov_minor, delivered_orders, rto_orders,
              first_identified_at, preferred_channel, preferred_device, top_category, acquisition_source,
              health_band, churn_score, lifecycle_stage, last_activity_at
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
        customerRef: r.customer_ref ?? null,
        lifetimeOrders: BigInt(String(r.lifetime_orders)),
        lifetimeValueMinor: BigInt(String(r.lifetime_value_minor)),
        // aov_minor: bigint minor units (drop any decimal tail — it is an exact integer in the mart).
        aovMinor: r.aov_minor == null ? null : BigInt(String(r.aov_minor).split('.')[0] ?? '0'),
        deliveredOrders: BigInt(String(r.delivered_orders)),
        rtoOrders: BigInt(String(r.rto_orders)),
        firstIdentifiedAt: r.first_identified_at ?? null,
        preferredChannel: r.preferred_channel ?? null,
        preferredDevice: r.preferred_device ?? null,
        topCategory: r.top_category ?? null,
        acquisitionSource: r.acquisition_source ?? null,
        healthBand: r.health_band ?? null,
        churnScore: r.churn_score == null ? null : Number(r.churn_score),
        lifecycleStage: r.lifecycle_stage ?? null,
        lastActivityAt: r.last_activity_at ?? null,
      })),
    };
  });
}
