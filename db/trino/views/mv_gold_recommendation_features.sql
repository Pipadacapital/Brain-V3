-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_recommendation_features
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_recommendation_features.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_recommendation_features). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Recommendation INPUT features (a Gold SERVING product, NOT a feature-precompute table). monetary_minor BIGINT minor units + currency_code. Grain (brand_id, brain_id).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_recommendation_features;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_recommendation_features. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_recommendation_features AS
SELECT
  brand_id,
  brain_id,
  recency_days,
  frequency,
  monetary_minor,
  currency_code,
  top_channel,
  distinct_products,
  tenure_days,
  updated_at
FROM iceberg.brain_gold.gold_recommendation_features;
