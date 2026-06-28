/**
 * getRepeatLatency — analytics use-case (ADR-002 sole-read-path) for the #32b retention latency.
 *
 * Time-to-2nd-purchase distribution over the Gold mart gold_repeat_latency, via computeRepeatLatency
 * (metric engine) through the withSilverBrand seam (I-ST01 — the engine is the sole Gold reader; the
 * UI never queries the lakehouse directly). Returns the brand median days-to-2nd-purchase plus the
 * fixed six-bucket histogram. NO ad-hoc arithmetic (D-3); the mart computes the exact integer median.
 * NO MONEY (integer day math only). Honest no_data when the brand has no customers.
 *
 * Serializes bigint → string (D-1) and returns generated_at (honest server compute time) so the
 * FreshnessBadge shows a real served-at. brandId from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/repeat-latency.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeRepeatLatency } from '@brain/metric-engine';

export interface RepeatLatencyBucketDto {
  bucket_key: string;
  bucket_order: number;
  bucket_lo_days: number;
  bucket_hi_days: number | null;
  customers: string; // bigint → string
}

export type RepeatLatencyResult =
  | { state: 'no_data'; generated_at: string }
  | {
      state: 'has_data';
      median_days_to_second_purchase: string | null; // bigint day count → string; null when no repeat customers
      second_order_customers: string; // bigint → string
      single_order_customers: string; // bigint → string
      total_customers: string; // bigint → string
      buckets: RepeatLatencyBucketDto[];
      generated_at: string;
    };

/**
 * getRepeatLatency — a brand's time-to-2nd-purchase median + histogram.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Trino Gold serving pool (mv_gold_repeat_latency).
 */
export async function getRepeatLatency(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<RepeatLatencyResult> {
  // served_at: honest server compute time for this read (the FreshnessBadge shows a real relative time).
  const generatedAt = new Date().toISOString();
  const result = await computeRepeatLatency(brandId, deps);

  if (!result.hasData) {
    return { state: 'no_data', generated_at: generatedAt };
  }

  return {
    state: 'has_data',
    generated_at: generatedAt,
    median_days_to_second_purchase:
      result.medianDaysToSecondPurchase === null ? null : String(result.medianDaysToSecondPurchase),
    second_order_customers: String(result.secondOrderCustomers),
    single_order_customers: String(result.singleOrderCustomers),
    total_customers: String(result.totalCustomers),
    buckets: result.buckets.map((b) => ({
      bucket_key: b.bucketKey,
      bucket_order: b.bucketOrder,
      bucket_lo_days: b.bucketLoDays,
      bucket_hi_days: b.bucketHiDays,
      customers: String(b.customers),
    })),
  };
}
