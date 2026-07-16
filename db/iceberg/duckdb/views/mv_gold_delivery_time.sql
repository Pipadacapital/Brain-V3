-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_delivery_time
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- serving projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_delivery_time). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Delivery-time DISTRIBUTION per courier. Grain (brand_id, courier, bucket) — one row per
-- (brand, courier, delivery-day bucket); the five fixed buckets 0-1 / 2-3 / 4-5 / 6-7 / 8+
-- (inclusive, non-overlapping) are ALWAYS all emitted per (brand, courier) (zero-count buckets
-- included), so the histogram panel never has holes. The PER-COURIER scalars
-- (avg_delivery_days, courier_shipment_count) are denormalized — identical on all five rows of a
-- (brand, courier); read the average from ANY one row (e.g. MAX), read the histogram from all five
-- (ORDER BY bucket_order).
--
-- INTEGER DAY MATH, NO money: shipment_count / courier_shipment_count are counts; the delivery-day
-- gap is dispatched→delivered whole days; avg_delivery_days is a behavioral average (a double, NOT a
-- money value). Σ shipment_count across the five buckets == courier_shipment_count.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_delivery_time; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_delivery_time AS
SELECT
  brand_id,
  courier,
  bucket,
  bucket_order,
  bucket_lo_days,
  bucket_hi_days,
  shipment_count,
  avg_delivery_days,
  courier_shipment_count,
  updated_at
FROM iceberg.brain_gold.gold_delivery_time;
