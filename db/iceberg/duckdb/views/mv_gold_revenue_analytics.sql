-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_revenue_analytics
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_revenue_analytics.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_revenue_analytics). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Money: realized_value_minor bigint MINOR units + currency_code, never blended. Grain (brand_id, period_month, lifecycle_state, currency_code).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_revenue_analytics; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_revenue_analytics AS
SELECT
  brand_id,
  period_month,
  lifecycle_state,
  currency_code,
  order_count,
  realized_value_minor,
  terminal_order_count,
  updated_at
FROM iceberg.brain_gold.gold_revenue_analytics;
