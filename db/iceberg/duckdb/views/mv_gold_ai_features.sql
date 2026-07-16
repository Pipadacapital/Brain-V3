-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_ai_features
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_ai_features.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_ai_features). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Per-customer ML feature vector. Money = bigint MINOR units (lifetime_value_minor, avg_order_value_minor) + currency_code; scores/counts never blended with money.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_ai_features; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_ai_features AS
SELECT
  brand_id,
  brain_id,
  order_count,
  lifetime_value_minor,
  currency_code,
  avg_order_value_minor,
  recency_days,
  distinct_channels,
  converted_flag,
  updated_at
FROM iceberg.brain_gold.gold_ai_features;
