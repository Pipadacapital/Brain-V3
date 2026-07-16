-- ============================================================
-- Brain V4 FIREHOSE — DuckDB serving VIEW: mv_silver_marketing_spend_by_hour
--
-- Thin projection over iceberg.brain_silver.silver_marketing_spend_by_hour (Meta hourly breakdown of
-- daily spend — hour_bucket = hourly_stats_aggregated_by_advertiser_time_zone). Isolated from the base
-- spend grain. App/BFF read ONLY this mv_*. Money: bigint MINOR + currency_code, never blended.
-- ${BRAND_PREDICATE} injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_silver_marketing_spend_by_hour AS
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
  hour_bucket,
  occurred_at,
  updated_at
FROM iceberg.brain_silver.silver_marketing_spend_by_hour;
