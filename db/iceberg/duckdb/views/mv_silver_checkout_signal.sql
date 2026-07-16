-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_silver_checkout_signal
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_silver_checkout_signal.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_silver.silver_checkout_signal). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Money: total_price_minor / total_discount_minor bigint MINOR units + currency_code, never blended. Grain (brand_id, event_id).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_silver_checkout_signal; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_silver_checkout_signal AS
SELECT
  brand_id,
  event_id,
  signal_type,
  source,
  order_id,
  risk_flag,
  total_price_minor,
  total_discount_minor,
  has_address,
  currency_code,
  occurred_at,
  is_synthetic,
  updated_at
FROM iceberg.brain_silver.silver_checkout_signal;
