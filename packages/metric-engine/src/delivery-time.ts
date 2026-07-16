/**
 * @brain/metric-engine — computeDeliveryTime (P3 — per-courier delivery-time distribution).
 *
 * The SOLE reader of the Gold mart gold_delivery_time, served through the serving view
 * brain_serving.mv_gold_delivery_time via withSilverBrand (I-ST01 — the engine is the only Gold
 * reader; the UI never queries the lakehouse directly). The mart, per (brand, courier), computes
 * the distribution of INTEGER delivery days (dispatched→delivered whole-day gap) from
 * silver_shipment, bucketed into five fixed ranges (0-1 / 2-3 / 4-5 / 6-7 / 8+).
 *
 * GRAIN: (brand_id, courier, bucket) — exactly FIVE bucket rows per (brand, courier) that has >=1
 * delivered shipment, ALWAYS all emitted (zero-count buckets included so the histogram never has
 * holes). The PER-COURIER scalars (avg_delivery_days, courier_shipment_count) are DENORMALIZED —
 * identical on all five rows of a (brand, courier); lifted off the first row per courier group.
 *
 * INTEGER DAY MATH, NO MONEY: shipment_count / courier_shipment_count are counts (bigint → string);
 * the delivery-day bounds are integers; avg_delivery_days is a behavioral average (a double, NOT a
 * money value — the no-float rule governs MONEY only). Σ shipment_count across the five buckets ==
 * courier_shipment_count (the average's denominator). hasData=false when the brand has zero rows.
 *
 * ── ISOLATION ──────────────────────────────────────────────────────────────────
 * Every read goes through withSilverBrand (brand predicate injected at the seam). brandId is from
 * session (D-1; NEVER body).
 *
 * @see db/iceberg/duckdb/gold/gold_delivery_time.py + db/iceberg/duckdb/views/mv_gold_delivery_time.sql
 * @see packages/metric-engine/src/repeat-latency.ts — the histogram-with-denormalized-scalars sibling
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** Coerce a serving numeric (string|number) to bigint, dropping any fractional tail. */
function toBig(v: string | number | null | undefined): bigint {
  return BigInt(String(v ?? '0').split('.')[0] ?? '0');
}

/** Coerce a nullable serving double to number | null (null stays null — honest "no delivered shipments"). */
function toNumOrNull(v: string | number | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** Coerce a nullable serving integer to number | null. */
function toIntOrNull(v: string | number | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(String(v).split('.')[0] ?? '0');
}

/** One delivery-time histogram bucket (the bar height per delivery-day band). */
export interface DeliveryTimeBucket {
  /** '0-1' | '2-3' | '4-5' | '6-7' | '8+'. */
  bucket: string;
  /** 1..5 — x-axis order for the histogram. */
  bucketOrder: number;
  /** Inclusive lower day bound. */
  bucketLoDays: number;
  /** Inclusive upper day bound; null for the open-ended '8+' bucket. */
  bucketHiDays: number | null;
  /** Delivered shipments whose delivery_days fall in this bucket (the bar height). */
  shipmentCount: bigint;
}

/** One courier's delivery-time profile: avg days + total delivered + the five-bucket histogram. */
export interface CourierDeliveryTime {
  courier: string;
  /** Behavioral mean delivery days (double; NOT money); null only on a malformed empty group. */
  avgDeliveryDays: number | null;
  /** Delivered shipments for this courier (= Σ shipmentCount across its five buckets). */
  courierShipmentCount: bigint;
  /** The five fixed buckets, ordered by bucketOrder asc. */
  buckets: DeliveryTimeBucket[];
}

export interface DeliveryTimeResult {
  /** True iff the brand has any delivery-time rows (honest no_data). */
  hasData: boolean;
  /** Per-courier profiles, ordered by delivered-shipment volume desc. */
  byCourier: CourierDeliveryTime[];
}

interface DeliveryRow {
  courier: string;
  bucket: string;
  bucket_order: string | number;
  bucket_lo_days: string | number;
  bucket_hi_days: string | number | null;
  shipment_count: string | number;
  avg_delivery_days: string | number | null;
  courier_shipment_count: string | number;
}

/**
 * computeDeliveryTime — per-courier delivery-time distribution (avg days + 5-bucket histogram, P3).
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Gold serving pool (gold_delivery_time via brain_serving.mv_gold_delivery_time).
 * @returns       Per-courier avg + histogram; hasData=false when the brand has no delivered shipments.
 */
export async function computeDeliveryTime(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<DeliveryTimeResult> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally to its single `?`.
    const rows = await scope.runScoped<DeliveryRow>(
      `SELECT courier, bucket, bucket_order, bucket_lo_days, bucket_hi_days,
              shipment_count, avg_delivery_days, courier_shipment_count
         FROM brain_serving.mv_gold_delivery_time
        WHERE ${BRAND_PREDICATE}
        ORDER BY courier ASC, bucket_order ASC`,
      [],
    );

    if (rows.length === 0) {
      return { hasData: false, byCourier: [] };
    }

    // Group the five denormalized bucket rows back into one profile per courier. The per-courier
    // scalars are identical on every row of a group — lifted off the first row seen.
    const byCourierMap = new Map<string, CourierDeliveryTime>();
    for (const r of rows) {
      const courier = String(r.courier);
      let entry = byCourierMap.get(courier);
      if (!entry) {
        entry = {
          courier,
          avgDeliveryDays: toNumOrNull(r.avg_delivery_days),
          courierShipmentCount: toBig(r.courier_shipment_count),
          buckets: [],
        };
        byCourierMap.set(courier, entry);
      }
      entry.buckets.push({
        bucket: String(r.bucket),
        bucketOrder: Number(r.bucket_order),
        bucketLoDays: Number(r.bucket_lo_days),
        bucketHiDays: toIntOrNull(r.bucket_hi_days),
        shipmentCount: toBig(r.shipment_count),
      });
    }

    // Order couriers by delivered-shipment volume desc (then name) — the busiest courier leads.
    const byCourier = [...byCourierMap.values()].sort((a, b) => {
      if (a.courierShipmentCount !== b.courierShipmentCount) {
        return a.courierShipmentCount > b.courierShipmentCount ? -1 : 1;
      }
      return a.courier.localeCompare(b.courier);
    });

    return { hasData: true, byCourier };
  });
}
