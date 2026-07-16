-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_silver_keyword_spend
--
-- Thin projection over the pre-materialized Iceberg breakdown mart
-- iceberg.brain_silver.silver_keyword_spend (Google Ads keyword-grain spend, spec §5).
-- This is an ISOLATED breakdown surface — it never touches the base
-- (brand_id, spend_event_id) spend grain that CAC/ROAS marts assume.
--
-- Money: spend_minor / conv_value_minor are bigint MINOR units + currency_code, never blended.
-- Grain (brand_id, platform, campaign_id, keyword_id, stat_date).
-- brand_id is the tenant key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_silver_keyword_spend AS
SELECT
  brand_id,
  spend_event_id,
  platform,
  campaign_id,
  campaign_name,
  keyword_id,
  keyword_text,
  keyword_match_type,
  stat_date,
  spend_minor,
  currency_code,
  impressions,
  clicks,
  conversions,
  conv_value_minor,
  ctr,
  occurred_at,
  updated_at
FROM iceberg.brain_silver.silver_keyword_spend;
