-- ============================================================
-- Brain V4 FIREHOSE — DuckDB serving VIEW: mv_silver_marketing_spend_by_demographic
--
-- Thin projection over the Spark-built breakdown mart
-- iceberg.brain_silver.silver_marketing_spend_by_demographic (Meta age/gender breakdown of daily spend).
-- Isolated from the base spend grain (its own event_ids); the app/BFF read ONLY this mv_*.
-- Money: spend_minor/conv_value_minor bigint MINOR + currency_code, never blended.
-- brand_id is the tenant key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_silver_marketing_spend_by_demographic AS
SELECT
  brand_id,
  spend_event_id,
  platform,
  level,
  level_id,
  campaign_id,
  campaign_name,
  stat_date,
  breakdown_key,
  spend_minor,
  currency_code,
  impressions,
  clicks,
  conversions,
  conv_value_minor,
  age,
  gender,
  occurred_at,
  updated_at
FROM iceberg.brain_silver.silver_marketing_spend_by_demographic;
