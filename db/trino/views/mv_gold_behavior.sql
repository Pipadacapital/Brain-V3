-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_behavior
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_behavior.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_behavior). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Engagement counters only (no money). Source PK (brand_id, behavior_date, page_type).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_behavior;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_behavior. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_behavior AS
SELECT
  brand_id,
  behavior_date,
  page_type,
  views,
  sessions,
  journeys,
  updated_at
FROM iceberg.brain_gold.gold_behavior;
