-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_executive_metrics
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_executive_metrics.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_executive_metrics). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Money: realized_value_minor bigint MINOR units + currency_code, never blended. Grain (brand_id, currency_code).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_executive_metrics; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_executive_metrics AS
SELECT
  brand_id,
  currency_code,
  total_orders,
  realized_value_minor,
  distinct_customers,
  terminal_orders,
  delivered_orders,
  rto_orders,
  cancelled_orders,
  refunded_orders,
  data_source,
  updated_at
FROM iceberg.brain_gold.gold_executive_metrics;
