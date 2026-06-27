-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer (ADDITIVE / dual-run)
-- mv_gold_customer_health
--
-- ASYNC materialized view that serves business truth FROM the Iceberg Gold
-- mart brain_gold_local.brain_gold.gold_customer_health via the external
-- Iceberg catalog. V4 serving path: StarRocks serves Gold FROM Iceberg, NOT a
-- dbt internal base table. Readers reach it ONLY via brain_serving.mv_*.
--
-- One-way rule (ADR-002): Iceberg -> Spark -> StarRocks -> API. Read-only MV.
--
-- DETERMINISTIC historical per-customer health/churn band. grain (brand_id,
-- brain_id) preserved. health_score is an INTEGER 0-100 (never blended with
-- money); lifetime_value_minor + currency_code are a sibling money pair carried
-- verbatim (never blended across currencies, never folded into the score).
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_customer_health
COMMENT "V4 serving MV over Iceberg Gold gold_customer_health (deterministic per-customer health/churn band)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 30 MINUTE)
AS
SELECT
  brand_id,
  brain_id,
  recency_days,
  frequency,
  health_score,
  health_band,
  last_order_at,
  lifetime_value_minor,
  currency_code,
  updated_at
FROM brain_gold_local.brain_gold.gold_customer_health;
