-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_journey
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_journey.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_journey). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Per-visitor journey rollup. NO money, NO PII (brain_anon_id is opaque). Grain (brand_id, brain_anon_id).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_journey;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_journey. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_journey AS
SELECT
  brand_id,
  brain_anon_id,
  first_touch_at,
  last_touch_at,
  first_channel,
  last_channel,
  touchpoint_count,
  distinct_channels,
  distinct_sessions,
  converted,
  converted_at,
  days_to_convert,
  updated_at
FROM iceberg.brain_gold.gold_journey;
