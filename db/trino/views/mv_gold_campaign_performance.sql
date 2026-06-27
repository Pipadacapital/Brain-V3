-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_campaign_performance
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_campaign_performance.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_campaign_performance). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Money: minor units (spend_minor, attributed_minor, cpc_minor) + currency_code; bps metrics are ratios.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_campaign_performance;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_campaign_performance. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_campaign_performance AS
SELECT
  brand_id,
  platform,
  campaign_id,
  currency_code,
  campaign_name,
  spend_minor,
  impressions,
  clicks,
  attributed_minor,
  ctr_bps,
  cpc_minor,
  roas_bps,
  updated_at
FROM iceberg.brain_gold.gold_campaign_performance;
