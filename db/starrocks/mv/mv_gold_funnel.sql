-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer (ADDITIVE / dual-run)
-- mv_gold_funnel
--
-- ASYNC materialized view that serves business truth FROM the Iceberg Gold
-- mart brain_gold_local.brain_gold.gold_funnel via the external Iceberg
-- catalog. V4 serving path: StarRocks serves Gold FROM Iceberg, NOT the dbt
-- internal brain_gold base table. Readers are NOT repointed here (Phase 4).
--
-- One-way rule (ADR-002): Iceberg -> dbt -> StarRocks -> API. Read-only MV.
--
-- No money columns (count-only funnel stages). brand_id + grain
-- (brand_id, funnel_date) preserved.
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_funnel
COMMENT "V4 serving MV over Iceberg Gold gold_funnel (daily conversion funnel stages)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 30 MINUTE)
AS
SELECT
  brand_id,
  funnel_date,
  sessions,
  product_viewed,
  cart_added,
  checkout_started,
  purchased,
  updated_at
FROM brain_gold_local.brain_gold.gold_funnel;
