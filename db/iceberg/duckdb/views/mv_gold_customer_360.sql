-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_customer_360
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_customer_360.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_customer_360). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Money: lifetime_value_minor + aov_minor are bigint MINOR units + currency_code; per-(brand_id, currency_code),
-- never blended/float (aov = exact integer division of lifetime_value by lifetime_orders). churn_score is a
-- non-money INTEGER 0-100 (never blended with money). Grain (brand_id, brain_id). B2 enrichment columns
-- (aov_minor / preferred_channel / preferred_device / top_category / acquisition_source / last_activity_at /
-- health_band / churn_score / lifecycle_stage) are folded onto each row by the Spark gold_customer_360 job.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_customer_360; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_customer_360 AS
SELECT
  brand_id,
  brain_id,
  customer_ref,
  lifetime_orders,
  lifetime_value_minor,
  aov_minor,
  currency_code,
  first_seen_at,
  first_identified_at,
  last_seen_at,
  last_activity_at,
  delivered_orders,
  rto_orders,
  cancelled_orders,
  refunded_orders,
  preferred_channel,
  preferred_device,
  top_category,
  acquisition_source,
  health_band,
  churn_score,
  lifecycle_stage,
  journey_summary,
  customer_watermark,
  updated_at
FROM iceberg.brain_gold.gold_customer_360;
