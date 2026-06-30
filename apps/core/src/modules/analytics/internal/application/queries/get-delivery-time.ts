/**
 * getDeliveryTime — analytics use-case (ADR-002 sole-read-path) for the P3 operations delivery-time.
 *
 * Per-courier delivery-time distribution over the Gold mart gold_delivery_time, via computeDeliveryTime
 * (metric engine) through the withSilverBrand seam (I-ST01 — the engine is the sole Gold reader; the
 * UI never queries the lakehouse directly). Returns, per courier, the average delivery days plus the
 * fixed five-bucket day histogram (0-1 / 2-3 / 4-5 / 6-7 / 8+). NO ad-hoc arithmetic (D-3); the mart
 * computes the exact integer day buckets + the AVG. NO MONEY (integer day math; avg is a behavioral
 * double). Honest no_data when the brand has no delivered shipments.
 *
 * Serializes bigint → string (D-1) and returns generated_at (honest server compute time) so the
 * FreshnessBadge shows a real served-at. brandId from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/delivery-time.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeDeliveryTime } from '@brain/metric-engine';

export interface DeliveryTimeBucketDto {
  bucket: string;
  bucket_order: number;
  bucket_lo_days: number;
  bucket_hi_days: number | null;
  shipment_count: string; // bigint → string
}

export interface DeliveryTimeCourierDto {
  courier: string;
  avg_delivery_days: number | null; // behavioral mean delivery days (double; NOT money)
  courier_shipment_count: string; // bigint → string
  buckets: DeliveryTimeBucketDto[];
}

export type DeliveryTimeResult =
  | { state: 'no_data'; generated_at: string }
  | {
      state: 'has_data';
      by_courier: DeliveryTimeCourierDto[];
      generated_at: string;
    };

/**
 * getDeliveryTime — a brand's per-courier average delivery days + day histogram.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Trino Gold serving pool (mv_gold_delivery_time).
 */
export async function getDeliveryTime(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<DeliveryTimeResult> {
  // served_at: honest server compute time for this read (the FreshnessBadge shows a real relative time).
  const generatedAt = new Date().toISOString();
  const result = await computeDeliveryTime(brandId, deps);

  if (!result.hasData) {
    return { state: 'no_data', generated_at: generatedAt };
  }

  return {
    state: 'has_data',
    generated_at: generatedAt,
    by_courier: result.byCourier.map((c) => ({
      courier: c.courier,
      avg_delivery_days: c.avgDeliveryDays,
      courier_shipment_count: String(c.courierShipmentCount),
      buckets: c.buckets.map((b) => ({
        bucket: b.bucket,
        bucket_order: b.bucketOrder,
        bucket_lo_days: b.bucketLoDays,
        bucket_hi_days: b.bucketHiDays,
        shipment_count: String(b.shipmentCount),
      })),
    })),
  };
}
