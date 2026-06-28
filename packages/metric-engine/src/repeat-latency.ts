/**
 * @brain/metric-engine — computeRepeatLatency (#32b — time-to-2nd-purchase retention latency).
 *
 * The SOLE reader of the Gold mart gold_repeat_latency, served through the Trino serving view
 * brain_serving.mv_gold_repeat_latency via withSilverBrand (I-ST01 — the engine is the only Gold
 * reader; the UI never queries the lakehouse directly). The mart, per brand, computes the
 * distribution of INTEGER days between each customer's 1st and 2nd order from silver_order_state.
 *
 * Grain: (brand_id, bucket_key) — EXACTLY six fixed, non-overlapping latency buckets
 * (0-7 / 8-14 / 15-30 / 31-60 / 61-90 / 90+), ALWAYS all emitted per brand (zero-count buckets
 * included so the histogram never has holes). The BRAND-LEVEL scalars
 * (median_days_to_second_purchase, second_order_customers, single_order_customers, total_customers)
 * are denormalized — identical on all six rows — so this reads ONE view and lifts the scalars off
 * the first row (constant across the brand).
 *
 * INTEGER DAY MATH, NO MONEY: every measure is a count or an integer day value (median is a bigint
 * day count; NULL when the brand has no repeat customers). Σ bucket_customers == second_order_customers
 * (the median's denominator). hasData=false when the brand has zero rows (no customers yet).
 *
 * @see db/iceberg/spark/gold/gold_repeat_latency.py + db/trino/views/mv_gold_repeat_latency.sql
 * @see packages/metric-engine/src/retention.ts — the cohort-grain retention sibling
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** Coerce a Trino numeric (string|number) to bigint, dropping any fractional tail. */
function toBig(v: string | number | null | undefined): bigint {
  return BigInt(String(v ?? '0').split('.')[0] ?? '0');
}

/** Coerce a nullable Trino numeric to bigint | null (null stays null — honest "no repeat customers"). */
function toBigOrNull(v: string | number | null | undefined): bigint | null {
  return v === null || v === undefined ? null : BigInt(String(v).split('.')[0] ?? '0');
}

/** Coerce a nullable Trino integer to number | null. */
function toNumOrNull(v: string | number | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(String(v).split('.')[0] ?? '0');
}

/** One latency-histogram bucket (the bar height per day band). */
export interface RepeatLatencyBucket {
  /** '0-7' | '8-14' | '15-30' | '31-60' | '61-90' | '90+'. */
  bucketKey: string;
  /** 1..6 — x-axis order for the histogram. */
  bucketOrder: number;
  /** Inclusive lower day bound. */
  bucketLoDays: number;
  /** Inclusive upper day bound; null for the open-ended '90+' bucket. */
  bucketHiDays: number | null;
  /** Customers whose days-to-2nd-purchase fall in this bucket (the bar height). */
  customers: bigint;
}

export interface RepeatLatencyResult {
  /** True iff the brand has any repeat-latency rows (honest no_data). */
  hasData: boolean;
  /** Exact integer median days between 1st and 2nd order; null when the brand has no repeat customers. */
  medianDaysToSecondPurchase: bigint | null;
  /** Customers with a 2nd order (= Σ bucket_customers = the median's denominator). */
  secondOrderCustomers: bigint;
  /** Customers with exactly one order (excluded from the median). */
  singleOrderCustomers: bigint;
  /** Customers with >= 1 order. */
  totalCustomers: bigint;
  /** The six fixed buckets, ordered by bucket_order asc. */
  buckets: RepeatLatencyBucket[];
}

interface LatencyRow {
  bucket_key: string;
  bucket_order: string | number;
  bucket_lo_days: string | number;
  bucket_hi_days: string | number | null;
  bucket_customers: string | number;
  median_days_to_second_purchase: string | number | null;
  second_order_customers: string | number;
  single_order_customers: string | number;
  total_customers: string | number;
}

/**
 * computeRepeatLatency — time-to-2nd-purchase median + 6-bucket histogram (#32b).
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Gold serving pool (gold_repeat_latency via brain_serving.mv_gold_repeat_latency).
 * @returns       Brand median scalars + the 6-bucket histogram; hasData=false when the brand has no rows.
 */
export async function computeRepeatLatency(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<RepeatLatencyResult> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally to its single `?`.
    const rows = await scope.runScoped<LatencyRow>(
      `SELECT bucket_key, bucket_order, bucket_lo_days, bucket_hi_days, bucket_customers,
              median_days_to_second_purchase, second_order_customers,
              single_order_customers, total_customers
         FROM brain_serving.mv_gold_repeat_latency
        WHERE ${BRAND_PREDICATE}
        ORDER BY bucket_order ASC`,
      [],
    );

    if (rows.length === 0) {
      return {
        hasData: false,
        medianDaysToSecondPurchase: null,
        secondOrderCustomers: 0n,
        singleOrderCustomers: 0n,
        totalCustomers: 0n,
        buckets: [],
      };
    }

    // The brand scalars are denormalized identically onto every bucket row — read from the first row.
    const head = rows[0] as LatencyRow;

    const buckets: RepeatLatencyBucket[] = rows.map((r) => ({
      bucketKey: String(r.bucket_key),
      bucketOrder: Number(r.bucket_order),
      bucketLoDays: Number(r.bucket_lo_days),
      bucketHiDays: toNumOrNull(r.bucket_hi_days),
      customers: toBig(r.bucket_customers),
    }));

    return {
      hasData: true,
      medianDaysToSecondPurchase: toBigOrNull(head.median_days_to_second_purchase),
      secondOrderCustomers: toBig(head.second_order_customers),
      singleOrderCustomers: toBig(head.single_order_customers),
      totalCustomers: toBig(head.total_customers),
      buckets,
    };
  });
}
