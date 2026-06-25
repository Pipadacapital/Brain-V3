-- ============================================================
-- Brain V4 Phase 3 — StarRocks ASYNC Materialized View serving layer
-- mv_gold_cohorts
--
-- Serves business truth FROM the Iceberg Gold mart
-- brain_gold_local.brain_gold.gold_cohorts (Phase-2 Spark-written Iceberg Gold),
-- NOT from the dbt-internal brain_gold.gold_cohorts base table.
--
-- ADDITIVE / dual-run: the app still reads the dbt brain_gold tables today.
-- This MV does NOT repoint any reader (Phase 4). ADR-0002 one-way rule holds:
-- Iceberg Gold -> StarRocks async MV -> Analytics API.
--
-- Money is preserved as bigint MINOR units (cohort_value_minor) + currency_code.
-- Per-(brand_id, currency_code); never blended. brand_id present (tenant key).
-- Mart grain / PK: (brand_id, cohort_month, currency_code) — acquisition-cohort rollup.
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_cohorts
COMMENT "V4 serving MV over Iceberg Gold gold_cohorts (additive; per-brand/currency money minor)"
DISTRIBUTED BY HASH(brand_id) BUCKETS 4
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  cohort_month,
  currency_code,
  cohort_size,
  cohort_value_minor,
  cohort_orders,
  updated_at
FROM brain_gold_local.brain_gold.gold_cohorts;
