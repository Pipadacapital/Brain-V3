-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_silver_marketing_spend
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_silver_marketing_spend.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_silver.silver_marketing_spend). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Money: spend_minor bigint MINOR units + currency_code, never blended. Grain (brand_id, spend_event_id).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_silver_marketing_spend; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_silver_marketing_spend AS
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
  -- ADDITIVE enriched insight set (money = bigint MINOR sharing currency_code; ratio = double).
  conversions,
  all_conversions,
  conv_value_minor,
  view_through_conversions,
  cpc_minor,
  cpm_minor,
  ctr,
  advertising_channel_type,
  -- FIREHOSE additive base-grain metrics (nullable; older rows NULL). Money = bigint MINOR + currency.
  video_views,
  reach,
  frequency,
  cpp_minor,
  unique_clicks,
  unique_ctr,
  inline_link_clicks,
  inline_link_click_ctr,
  outbound_clicks,
  unique_outbound_clicks,
  cost_per_unique_click_minor,
  cost_per_inline_link_click_minor,
  landing_page_views,
  purchase_roas_ratio,
  website_purchase_roas_ratio,
  mobile_app_purchase_roas_ratio,
  post_engagement,
  page_engagement,
  inline_post_engagement,
  video_p25_watched,
  video_p50_watched,
  video_p75_watched,
  video_p100_watched,
  video_thruplay_watched,
  video_30_sec_watched,
  video_avg_time_watched_secs,
  quality_ranking,
  engagement_rate_ranking,
  conversion_rate_ranking,
  -- ADDITIVE Google firehose base-grain metrics.
  video_view_rate,
  engagements,
  engagement_rate,
  cost_per_conversion_minor,
  value_per_conversion_minor,
  all_conversions_value_minor,
  cost_per_all_conversions_minor,
  average_cost_minor,
  search_impression_share,
  search_budget_lost_impression_share,
  search_rank_lost_impression_share,
  absolute_top_impression_percentage,
  top_impression_percentage,
  interactions,
  interaction_rate,
  conversions_from_interactions_rate,
  account_timezone,
  occurred_at,
  updated_at
FROM iceberg.brain_silver.silver_marketing_spend;
