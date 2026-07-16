-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_customer_health
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_customer_health.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_customer_health). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Deterministic per-customer health/churn band. health_score INTEGER 0-100 (never blended with money); lifetime_value_minor + currency_code carried verbatim.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_customer_health; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_customer_health AS
SELECT
  brand_id,
  brain_id,
  recency_days,
  frequency,
  health_score,
  health_band,
  last_order_at,
  lifetime_value_minor,
  currency_code,
  updated_at
FROM iceberg.brain_gold.gold_customer_health;
