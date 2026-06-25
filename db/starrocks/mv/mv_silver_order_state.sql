-- ============================================================
-- Brain V4 Phase 4a — StarRocks serving layer (Silver)
-- mv_silver_order_state — ASYNC materialized view over Iceberg Silver
--   source: brain_silver_local.brain_silver.silver_order_state
--   serving DB: brain_serving
-- ADDITIVE / dual-run: app still reads dbt brain_silver.silver_order_state today.
-- Phase 4b repoints readers to brain_serving.mv_silver_order_state.
-- Money preserved as bigint minor units (order_value_minor) + currency_code,
-- never blended; brand_id present; grain key = (brand_id, order_id).
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_silver_order_state
COMMENT "V4 serving MV over Iceberg Silver silver_order_state (per-currency minor-unit money)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  order_id,
  brain_id,
  lifecycle_state,
  is_terminal,
  order_value_minor,
  currency_code,
  first_event_at,
  state_effective_at,
  max_ingested_at,
  updated_at
FROM brain_silver_local.brain_silver.silver_order_state;
