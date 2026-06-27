/**
 * @brain/metric-engine — computeRetention (B7 — repeat-purchase / returning-customer retention).
 *
 * The retention dashboard's source, served from the Gold mart gold_retention through withSilverBrand
 * (I-ST01 — the engine is the sole Gold reader; the UI never queries the lakehouse directly). gold_retention
 * is the deterministic per-acquisition-cohort roll-up of silver_customer (the brain_id-keyed customer fold of
 * silver_order_state) — one row per (brand_id, cohort_month) with the additive retention components + the
 * integer-bps rates.
 *
 * Gold stores ADDITIVE components (cohort_customers, repeat_customers, total_orders, repeat_orders) plus the
 * pre-divided integer-BPS rates (V4 no-float rule — rates are EXACT basis points ×10000, never a stored
 * float). This reader:
 *   - SUMs the additive components for the brand-level headline (repeat_rate / returning_rate / orders-per-
 *     customer recomputed NON-additively at read from the summed components — ADR-004),
 *   - and projects the per-cohort rows VERBATIM (the stored bps re-expressed as exact decimal strings).
 * Every ratio is an EXACT decimal string from integer operands (no float); null when the denominator is 0
 * (honest no-data, never divide-by-zero).
 *
 * NO MONEY: retention is purely behavioral counts + rates. currency_code is a per-cohort descriptor only.
 *
 * @see db/iceberg/spark/gold/gold_retention.py + brain_serving.mv_gold_retention (Trino view over Iceberg)
 * @see packages/metric-engine/src/executive-metrics.ts (sibling Gold cohort reader — computeCohortRetention)
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** Format an exact integer ratio numerator/denominator to a fixed-precision decimal string (no float). */
function exactRatioString(numerator: bigint, denominator: bigint, fractionalDigits = 2): string {
  const scale = 10n ** BigInt(fractionalDigits);
  const scaled = (numerator * scale) / denominator;
  const intPart = scaled / scale;
  const fracPart = scaled % scale;
  const absFrac = fracPart < 0n ? -fracPart : fracPart;
  return `${intPart.toString()}.${absFrac.toString().padStart(fractionalDigits, '0')}`;
}

/** Re-express a stored integer-bps rate (×10000) as a 2dp percent string; null when the bps is null. */
function bpsToPct(bps: bigint | null): string | null {
  if (bps === null) return null;
  // bps is hundredths of a percent (10000 = 100.00%). Percent = bps / 100, 2dp.
  return exactRatioString(bps, 100n, 2);
}

export interface RetentionCohortRow {
  /** Acquisition cohort 'YYYY-MM' (first-seen month) — same grain as gold_cohorts. */
  cohortMonth: string;
  currencyCode: string;
  /** Customers acquired in the cohort. */
  cohortCustomers: bigint;
  /** Of those, customers with >=2 lifetime orders (purchased more than once). */
  repeatCustomers: bigint;
  /** Total lifetime orders across the cohort. */
  totalOrders: bigint;
  /** Orders beyond each customer's first/acquiring order (the returning purchases). */
  repeatOrders: bigint;
  /** repeat_customers ÷ cohort_customers, percent string (from stored bps); null when no customers. */
  repeatPurchaseRatePct: string | null;
  /** repeat_orders ÷ total_orders, percent string (from stored bps); null when no orders. */
  returningCustomerRatePct: string | null;
  /** total_orders ÷ cohort_customers, 2dp ratio string (from stored bps); null when no customers. */
  avgOrdersPerCustomer: string | null;
}

export interface RetentionResult {
  hasData: boolean;
  /** Brand-level headline (NON-additively derived from the summed cohort components, ADR-004). */
  totals: {
    cohortCustomers: bigint;
    repeatCustomers: bigint;
    totalOrders: bigint;
    repeatOrders: bigint;
    repeatPurchaseRatePct: string | null;
    returningCustomerRatePct: string | null;
    avgOrdersPerCustomer: string | null;
  };
  /** Per-acquisition-cohort rows, ascending by cohort_month. */
  cohorts: RetentionCohortRow[];
}

/**
 * computeRetention — repeat-purchase / returning-customer retention by acquisition cohort (B7).
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param deps    - The Gold serving pool (gold_retention via brain_serving.mv_gold_retention).
 * @returns       Per-cohort rows + a brand-level headline; hasData=false when the brand has no rows.
 */
export async function computeRetention(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<RetentionResult> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      cohort_month: string;
      currency_code: string;
      cohort_customers: string | number;
      repeat_customers: string | number;
      total_orders: string | number;
      repeat_orders: string | number;
      repeat_purchase_rate_bps: string | number | null;
      returning_customer_rate_bps: string | number | null;
      avg_orders_per_customer_bps: string | number | null;
    }>(
      `SELECT cohort_month, currency_code,
              cohort_customers, repeat_customers, total_orders, repeat_orders,
              repeat_purchase_rate_bps, returning_customer_rate_bps, avg_orders_per_customer_bps
         FROM brain_serving.mv_gold_retention
        WHERE ${BRAND_PREDICATE}
        ORDER BY cohort_month ASC`,
      [],
    );

    if (rows.length === 0) {
      return {
        hasData: false,
        totals: {
          cohortCustomers: 0n,
          repeatCustomers: 0n,
          totalOrders: 0n,
          repeatOrders: 0n,
          repeatPurchaseRatePct: null,
          returningCustomerRatePct: null,
          avgOrdersPerCustomer: null,
        },
        cohorts: [],
      };
    }

    const toBigint = (v: string | number | null | undefined): bigint =>
      BigInt(String(v ?? '0').split('.')[0] ?? '0');
    const toBigintOrNull = (v: string | number | null | undefined): bigint | null =>
      v === null || v === undefined ? null : BigInt(String(v).split('.')[0] ?? '0');

    let sumCustomers = 0n;
    let sumRepeatCustomers = 0n;
    let sumOrders = 0n;
    let sumRepeatOrders = 0n;

    const cohorts: RetentionCohortRow[] = rows.map((r) => {
      const cohortCustomers = toBigint(r.cohort_customers);
      const repeatCustomers = toBigint(r.repeat_customers);
      const totalOrders = toBigint(r.total_orders);
      const repeatOrders = toBigint(r.repeat_orders);
      sumCustomers += cohortCustomers;
      sumRepeatCustomers += repeatCustomers;
      sumOrders += totalOrders;
      sumRepeatOrders += repeatOrders;
      return {
        cohortMonth: r.cohort_month,
        currencyCode: r.currency_code,
        cohortCustomers,
        repeatCustomers,
        totalOrders,
        repeatOrders,
        repeatPurchaseRatePct: bpsToPct(toBigintOrNull(r.repeat_purchase_rate_bps)),
        returningCustomerRatePct: bpsToPct(toBigintOrNull(r.returning_customer_rate_bps)),
        avgOrdersPerCustomer:
          cohortCustomers > 0n ? exactRatioString(totalOrders, cohortCustomers) : null,
      };
    });

    return {
      hasData: true,
      totals: {
        cohortCustomers: sumCustomers,
        repeatCustomers: sumRepeatCustomers,
        totalOrders: sumOrders,
        repeatOrders: sumRepeatOrders,
        // NON-additive ratios recomputed from the SUMMED components (ADR-004) — exact integer math.
        repeatPurchaseRatePct:
          sumCustomers > 0n ? exactRatioString(sumRepeatCustomers * 100n, sumCustomers) : null,
        returningCustomerRatePct:
          sumOrders > 0n ? exactRatioString(sumRepeatOrders * 100n, sumOrders) : null,
        avgOrdersPerCustomer:
          sumCustomers > 0n ? exactRatioString(sumOrders, sumCustomers) : null,
      },
      cohorts,
    };
  });
}
