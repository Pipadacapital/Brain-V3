-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_conversion_feedback
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_conversion_feedback.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_conversion_feedback). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Form/funnel counters only (no money). Source PK (brand_id, feedback_date, form_id).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_conversion_feedback;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_conversion_feedback. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_conversion_feedback AS
SELECT
  brand_id,
  feedback_date,
  form_id,
  submissions,
  sessions,
  journeys,
  payments_succeeded,
  updated_at
FROM iceberg.brain_gold.gold_conversion_feedback;
