-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_repeat_latency
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- serving projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_repeat_latency). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Time-to-2nd-purchase RETENTION LATENCY. Grain (brand_id, bucket_key) — one row per
-- (brand, latency bucket); the six fixed buckets 0-7 / 8-14 / 15-30 / 31-60 / 61-90 / 90+
-- (inclusive, non-overlapping) are ALWAYS all emitted per brand (zero-count buckets included),
-- so the histogram panel never has holes. The BRAND-LEVEL scalars
-- (median_days_to_second_purchase, second_order_customers, single_order_customers,
-- total_customers) are denormalized — identical on all six rows of a brand; read the median
-- from ANY one row (e.g. MAX), read the histogram from all six (ORDER BY bucket_order).
--
-- INTEGER DAY MATH, NO money: every measure is a count or an integer day value (median is a
-- bigint day count). Σ bucket_customers across the six buckets == second_order_customers
-- (the median's denominator).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_repeat_latency; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_repeat_latency AS
SELECT
  brand_id,
  bucket_key,
  bucket_order,
  bucket_lo_days,
  bucket_hi_days,
  bucket_customers,
  median_days_to_second_purchase,
  second_order_customers,
  single_order_customers,
  total_customers,
  updated_at
FROM iceberg.brain_gold.gold_repeat_latency;
