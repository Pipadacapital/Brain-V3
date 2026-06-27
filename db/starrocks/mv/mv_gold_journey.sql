-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer (ADDITIVE / dual-run)
-- mv_gold_journey
--
-- ASYNC materialized view that serves the journey-intelligence rollup FROM the
-- Iceberg Gold mart brain_gold_local.brain_gold.gold_journey via the external
-- Iceberg catalog. V4 serving path: StarRocks serves Gold FROM Iceberg, NOT a
-- dbt-internal base table. Readers reach this ONLY through the metric-engine seam.
--
-- One-way rule (ADR-002): Iceberg -> Spark -> StarRocks -> API. Read-only MV.
--
-- INTELLIGENCE rollup: NO money columns (journeys are not monetary) and NO PII
-- (brain_anon_id is the opaque pseudonymous journey key). brand_id + grain
-- (brand_id, brain_anon_id) preserved.
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_journey
COMMENT "V4 serving MV over Iceberg Gold gold_journey (per-visitor journey rollup)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 30 MINUTE)
AS
SELECT
  brand_id,
  brain_anon_id,
  first_touch_at,
  last_touch_at,
  first_channel,
  last_channel,
  touchpoint_count,
  distinct_channels,
  distinct_sessions,
  converted,
  converted_at,
  days_to_convert,
  updated_at
FROM brain_gold_local.brain_gold.gold_journey;
