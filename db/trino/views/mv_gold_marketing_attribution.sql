-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_marketing_attribution
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_marketing_attribution.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_marketing_attribution). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Marketing-attribution dashboard mart. credited_revenue_minor / realized_revenue_minor SIGNED BIGINT minor units + currency_code, never blended.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_marketing_attribution;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_marketing_attribution. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_marketing_attribution AS
SELECT
  brand_id,
  credit_id,
  order_id,
  brain_anon_id,
  touch_seq,
  channel,
  campaign_id,
  model_id,
  row_kind,
  credited_revenue_minor,
  currency_code,
  realized_revenue_minor,
  reversed_of_credit_id,
  confidence_grade,
  attribution_confidence,
  model_version,
  occurred_at,
  economic_effective_at,
  billing_posted_period,
  updated_at
FROM iceberg.brain_gold.gold_marketing_attribution;
