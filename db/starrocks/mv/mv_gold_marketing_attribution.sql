-- mv_gold_marketing_attribution.sql — Brain V4 Phase 3 serving layer (ADDITIVE / dual-run).
--
-- StarRocks ASYNC MATERIALIZED VIEW serving the Iceberg Gold marketing-attribution dashboard mart
-- (brain_gold_local.brain_gold.gold_marketing_attribution) FROM the internal serving DB brain_serving.
-- V4 path: StarRocks serves business truth FROM Iceberg Gold (not the dbt internal brain_gold view).
-- NON-BREAKING: the app still reads brain_gold today; Phase 4 repoints readers. Honest 0 rows builds fine.
--
-- Money columns preserved as SIGNED BIGINT minor units, per-currency, NEVER blended:
--   credited_revenue_minor, realized_revenue_minor + currency_code.
-- brand_id (tenant key) is the distribution key; credit_id is the mart key.

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_marketing_attribution
DISTRIBUTED BY HASH(brand_id) BUCKETS 8
REFRESH ASYNC START('2026-01-01 00:00:00') EVERY (INTERVAL 5 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
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
FROM brain_gold_local.brain_gold.gold_marketing_attribution;
