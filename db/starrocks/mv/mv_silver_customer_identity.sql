-- ============================================================
-- Brain V4 Phase 4a — StarRocks serving layer (Silver)
-- mv_silver_customer_identity — ASYNC materialized view over Iceberg Silver
--   source: brain_silver_local.brain_silver.silver_customer_identity
--   serving DB: brain_serving
-- ADDITIVE / dual-run: app still reads dbt brain_silver.silver_customer_identity today.
-- Phase 4b repoints readers to brain_serving.mv_silver_customer_identity.
-- No money columns; brand_id present; grain key = (brand_id, brain_id).
-- silver_customer_identity is the StarRocks-side export of the Neo4j identity SoR
-- (ADR-0004); this MV serves the exported snapshot, it does not become the SoR.
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_silver_customer_identity
COMMENT "V4 serving MV over Iceberg Silver silver_customer_identity (Neo4j export snapshot)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  brain_id,
  lifecycle_state,
  merged_into,
  minted_at,
  first_identified_at,
  updated_at
FROM brain_silver_local.brain_silver.silver_customer_identity;
