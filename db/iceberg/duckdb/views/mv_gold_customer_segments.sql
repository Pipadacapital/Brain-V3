-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_customer_segments
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_customer_segments.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_customer_segments). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Per-(brand_id, segment_type, segment) rollup. segment_type is the dimension discriminator:
--   'value_tier' — the value ladder (high_value / mid_value / low_value / no_realized_value)
--   'lifecycle'  — the named lifecycle ladder (VIP / high_value / loyal / first_time_buyer /
--                  at_risk / churned / cart_abandoner / window_shopper)
-- The label 'high_value' exists in BOTH ladders; segment_type is what keeps them distinct, so a
-- reader MUST filter segment_type (e.g. WHERE segment_type = 'lifecycle') to avoid double-counting.
-- Money: segment_value_minor bigint MINOR units (no currency_code at this grain), never blended across brands.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_customer_segments; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_customer_segments AS
SELECT
  brand_id,
  segment_type,
  segment,
  customer_count,
  segment_value_minor,
  updated_at
FROM iceberg.brain_gold.gold_customer_segments;
