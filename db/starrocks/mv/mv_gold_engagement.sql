-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer (ADDITIVE / dual-run)
-- mv_gold_engagement
--
-- ASYNC materialized view that serves business truth FROM the Iceberg Gold
-- mart brain_gold_local.brain_gold.gold_engagement via the external Iceberg
-- catalog. V4 serving path: StarRocks serves Gold FROM Iceberg, NOT the dbt
-- internal brain_gold base table. Readers are NOT repointed here (Phase 4).
--
-- One-way rule (ADR-002): Iceberg -> dbt -> StarRocks -> API. Read-only MV.
--
-- No money columns (engagement signal counts). brand_id + grain
-- (brand_id, engagement_date, signal_type) preserved.
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_engagement
COMMENT "V4 serving MV over Iceberg Gold gold_engagement (daily per-signal engagement)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 30 MINUTE)
AS
SELECT
  brand_id,
  engagement_date,
  signal_type,
  signal_count,
  sessions,
  pages,
  avg_scroll_pct,
  updated_at
FROM brain_gold_local.brain_gold.gold_engagement;
