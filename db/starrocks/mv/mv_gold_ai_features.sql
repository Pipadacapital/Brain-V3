-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer (ADDITIVE / dual-run)
-- mv_gold_ai_features
--
-- ASYNC materialized view that serves the AI/ML input feature vector FROM the
-- Iceberg Gold mart brain_gold_local.brain_gold.gold_ai_features via the external
-- Iceberg catalog. V4 serving path: StarRocks serves Gold FROM Iceberg, NOT a dbt
-- internal brain_gold base table. Readers reach this ONLY through the metric-engine
-- seam (packages/metric-engine/src/ai-features.ts) — never the bare Iceberg table.
--
-- One-way rule (ADR-002): Iceberg -> Spark -> StarRocks -> API. Read-only MV.
--
-- A Gold SERVING product, NOT the banned feature-precompute table (no
-- feature_customer_daily / brain_feature). Grain (brand_id, brain_id) preserved.
-- Money = bigint MINOR units (lifetime_value_minor, avg_order_value_minor) +
-- sibling currency_code; scores/counts never blended with money.
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_ai_features
COMMENT "V4 serving MV over Iceberg Gold gold_ai_features (per-customer ML feature vector)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 30 MINUTE)
AS
SELECT
  brand_id,
  brain_id,
  order_count,
  lifetime_value_minor,
  currency_code,
  avg_order_value_minor,
  recency_days,
  distinct_channels,
  converted_flag,
  updated_at
FROM brain_gold_local.brain_gold.gold_ai_features;
