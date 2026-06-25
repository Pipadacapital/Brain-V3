-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving MV: mv_gold_behavior
-- ADDITIVE / dual-run. Serves business truth FROM Iceberg Gold
-- (brain_gold_local.brain_gold.gold_behavior) via an async materialized
-- view in the internal serving DB brain_serving. Does NOT touch dbt
-- brain_gold base tables or any reader (Phase 4 repoints readers).
--
-- ADR-002 one-way rule: Iceberg -> dbt -> StarRocks -> Analytics API.
-- This MV reads the EXTERNAL Iceberg Gold catalog only.
--
-- Source PK: (brand_id, behavior_date, page_type)
-- Money cols: none (engagement counters only)
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_behavior
DISTRIBUTED BY HASH(brand_id) BUCKETS 4
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  behavior_date,
  page_type,
  views,
  sessions,
  journeys,
  updated_at
FROM brain_gold_local.brain_gold.gold_behavior;
