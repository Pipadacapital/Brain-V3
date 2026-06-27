-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_silver_marketing_spend
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_silver_marketing_spend.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_silver.silver_marketing_spend). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Money: spend_minor bigint MINOR units + currency_code, never blended. Grain (brand_id, spend_event_id).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_silver_marketing_spend;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_silver_marketing_spend. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_silver_marketing_spend AS
SELECT
  brand_id,
  spend_event_id,
  platform,
  level,
  level_id,
  parent_id,
  campaign_id,
  campaign_name,
  stat_date,
  spend_minor,
  currency_code,
  impressions,
  clicks,
  account_timezone,
  occurred_at,
  updated_at
FROM iceberg.brain_silver.silver_marketing_spend;
