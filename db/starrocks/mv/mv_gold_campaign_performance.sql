-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving MV: mv_gold_campaign_performance
-- ADDITIVE / dual-run. Serves business truth FROM Iceberg Gold
-- (brain_gold_local.brain_gold.gold_campaign_performance) via an async
-- materialized view in the internal serving DB brain_serving. Does NOT touch
-- dbt brain_gold base tables or any reader (Phase 4 repoints readers).
--
-- ADR-002 one-way rule: Iceberg -> dbt -> StarRocks -> Analytics API.
--
-- Source PK: (brand_id, platform, campaign_id)
-- Money: minor units (spend_minor, attributed_minor, cpc_minor) + currency_code.
--        Per-currency, never blended. bps metrics (ctr_bps, roas_bps) are ratios.
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_campaign_performance
DISTRIBUTED BY HASH(brand_id) BUCKETS 4
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
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
FROM brain_gold_local.brain_gold.gold_campaign_performance;
