-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_customer_scores
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_customer_scores.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_customer_scores). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- RFM/churn score per customer per scoring day. Money: lifetime_value_minor + currency_code, never blended. Grain (brand_id, brain_id, scored_on).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_customer_scores; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_customer_scores AS
SELECT
  brand_id,
  brain_id,
  currency_code,
  scored_on,
  lifetime_orders,
  lifetime_value_minor,
  days_since_last_order,
  recency_score,
  frequency_score,
  monetary_score,
  churn_risk,
  data_source,
  computed_at
FROM iceberg.brain_gold.gold_customer_scores;
