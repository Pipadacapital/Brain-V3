-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_silver_order_state
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_silver_order_state.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_silver.silver_order_state). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Money: order_value_minor bigint MINOR units + currency_code, never blended. Grain (brand_id, order_id).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_silver_order_state; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_silver_order_state AS
SELECT
  brand_id,
  order_id,
  brain_id,
  lifecycle_state,
  is_terminal,
  order_value_minor,
  currency_code,
  first_event_at,
  state_effective_at,
  max_ingested_at,
  updated_at
FROM iceberg.brain_silver.silver_order_state;
