-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer
-- mv_gold_revenue_analytics — ASYNC materialized view over Iceberg Gold
--   source: brain_gold_local.brain_gold.gold_revenue_analytics
--   serving DB: brain_serving
-- ADDITIVE / dual-run: app still reads dbt brain_gold.gold_revenue_analytics today.
-- Money preserved as bigint minor units (realized_value_minor) + currency_code,
-- never blended; brand_id present; grain key = (brand_id, period_month, lifecycle_state, currency_code).
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_revenue_analytics
COMMENT "V4 serving MV over Iceberg Gold gold_revenue_analytics (per-currency minor-unit money)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  period_month,
  lifecycle_state,
  currency_code,
  order_count,
  realized_value_minor,
  terminal_order_count,
  updated_at
FROM brain_gold_local.brain_gold.gold_revenue_analytics;
