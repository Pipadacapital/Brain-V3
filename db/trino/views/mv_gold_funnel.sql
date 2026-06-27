-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_funnel
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_funnel.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_funnel). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Count-only funnel stages (no money). Grain (brand_id, funnel_date).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_funnel;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_funnel. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_funnel AS
SELECT
  brand_id,
  funnel_date,
  sessions,
  product_viewed,
  cart_added,
  checkout_started,
  purchased,
  updated_at
FROM iceberg.brain_gold.gold_funnel;
