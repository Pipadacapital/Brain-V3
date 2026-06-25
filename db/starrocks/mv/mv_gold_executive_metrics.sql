-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer
-- mv_gold_executive_metrics — ASYNC materialized view over Iceberg Gold
--   source: brain_gold_local.brain_gold.gold_executive_metrics
--   serving DB: brain_serving
-- ADDITIVE / dual-run: app still reads dbt brain_gold.gold_executive_metrics today.
-- Money preserved as bigint minor units (realized_value_minor) + currency_code,
-- never blended; brand_id present; grain key = (brand_id, currency_code).
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_executive_metrics
COMMENT "V4 serving MV over Iceberg Gold gold_executive_metrics (per-currency minor-unit money)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  currency_code,
  total_orders,
  realized_value_minor,
  distinct_customers,
  terminal_orders,
  delivered_orders,
  rto_orders,
  cancelled_orders,
  refunded_orders,
  data_source,
  updated_at
FROM brain_gold_local.brain_gold.gold_executive_metrics;
