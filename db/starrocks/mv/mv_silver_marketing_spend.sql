-- ============================================================
-- Brain V4 Phase 4a — StarRocks serving layer (Silver)
-- mv_silver_marketing_spend — ASYNC materialized view over Iceberg Silver
--   source: brain_silver_local.brain_silver.silver_marketing_spend
--   serving DB: brain_serving
-- ADDITIVE / dual-run: app still reads dbt brain_silver.silver_marketing_spend today.
-- Phase 4b repoints readers to brain_serving.mv_silver_marketing_spend.
-- Money preserved as bigint minor units (spend_minor) + currency_code,
-- never blended; brand_id present; grain key = (brand_id, spend_event_id).
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_silver_marketing_spend
COMMENT "V4 serving MV over Iceberg Silver silver_marketing_spend (per-currency minor-unit money)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
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
FROM brain_silver_local.brain_silver.silver_marketing_spend;
