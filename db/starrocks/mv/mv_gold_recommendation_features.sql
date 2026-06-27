-- ============================================================
-- Brain V4 — StarRocks serving layer (ADDITIVE / dual-run)
-- mv_gold_recommendation_features
--
-- ASYNC materialized view that serves recommendation INPUT features FROM the
-- Iceberg Gold mart brain_gold_local.brain_gold.gold_recommendation_features via
-- the external Iceberg catalog. V4 serving path: StarRocks serves Gold FROM
-- Iceberg (the SOLE serving surface; readers hit brain_serving.mv_*, never a bare
-- brain_gold. DB). This is a Gold SERVING product, NOT the retired permanent
-- feature-precompute table.
--
-- One-way rule (ADR-002): Iceberg -> Spark -> StarRocks -> API. Read-only MV.
--
-- MONEY: monetary_minor is BIGINT minor units paired with the sibling
-- currency_code (never a float, never blended across currencies). brand_id +
-- grain (brand_id, brain_id) preserved. brain_id is the sole identity key (no PII).
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_recommendation_features
COMMENT "V4 serving MV over Iceberg Gold gold_recommendation_features (per-customer RFM + behaviour features)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 30 MINUTE)
AS
SELECT
  brand_id,
  brain_id,
  recency_days,
  frequency,
  monetary_minor,
  currency_code,
  top_channel,
  distinct_products,
  tenure_days,
  updated_at
FROM brain_gold_local.brain_gold.gold_recommendation_features;
