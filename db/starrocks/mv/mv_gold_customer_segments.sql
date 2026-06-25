-- ============================================================
-- Brain V4 Phase 3 — StarRocks ASYNC Materialized View serving layer
-- mv_gold_customer_segments
--
-- Serves business truth FROM the Iceberg Gold mart
-- brain_gold_local.brain_gold.gold_customer_segments (Phase-2 Spark-written Iceberg Gold),
-- NOT from the dbt-internal brain_gold.gold_customer_segments base table.
--
-- ADDITIVE / dual-run: the app still reads the dbt brain_gold tables today.
-- This MV does NOT repoint any reader (Phase 4). ADR-0002 one-way rule holds:
-- Iceberg Gold -> StarRocks async MV -> Analytics API.
--
-- Money is preserved as bigint MINOR units (segment_value_minor).
-- NOTE: this aggregate mart carries no currency_code column at the Gold grain; it is a
-- per-(brand_id, segment) rollup. Money stays minor-unit and is never blended across brands.
-- brand_id present (tenant key). Mart grain / PK: (brand_id, segment).
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_customer_segments
COMMENT "V4 serving MV over Iceberg Gold gold_customer_segments (additive; per-brand money minor)"
DISTRIBUTED BY HASH(brand_id) BUCKETS 4
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  segment,
  customer_count,
  segment_value_minor,
  updated_at
FROM brain_gold_local.brain_gold.gold_customer_segments;
