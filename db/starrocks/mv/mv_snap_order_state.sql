-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer
-- mv_snap_order_state — ASYNC materialized view over the Iceberg snapshot mart
--   source: brain_gold_local.brain_silver.snap_order_state
--     (snap_order_state is materialized in the brain_silver namespace; read here through
--      the brain_gold_local catalog, which exposes every namespace over the same REST endpoint)
--   serving DB: brain_serving
-- ADDITIVE / dual-run: app still reads the dbt snap_order_state today.
-- Money preserved as bigint minor units (order_value_minor) + currency_code,
-- never blended; brand_id present; grain key = (brand_id, order_id, snapshot_date).
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_snap_order_state
COMMENT "V4 serving MV over Iceberg snap_order_state (per-currency minor-unit money)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  order_id,
  snapshot_date,
  brain_id,
  lifecycle_state,
  is_terminal,
  order_value_minor,
  currency_code,
  state_effective_at,
  computed_at
FROM brain_gold_local.brain_silver.snap_order_state;
