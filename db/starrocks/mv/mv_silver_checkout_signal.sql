-- ============================================================
-- Brain V4 Phase 4a — StarRocks serving layer (Silver)
-- mv_silver_checkout_signal — ASYNC materialized view over Iceberg Silver
--   source: brain_silver_local.brain_silver.silver_checkout_signal
--   serving DB: brain_serving
-- ADDITIVE / dual-run: app still reads dbt brain_silver.silver_checkout_signal today.
-- Phase 4b repoints readers to brain_serving.mv_silver_checkout_signal.
-- Money preserved as bigint minor units (total_price_minor, total_discount_minor)
-- + currency_code, never blended; brand_id present; grain key = (brand_id, event_id).
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_silver_checkout_signal
COMMENT "V4 serving MV over Iceberg Silver silver_checkout_signal (per-currency minor-unit money)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  event_id,
  signal_type,
  source,
  order_id,
  risk_flag,
  total_price_minor,
  total_discount_minor,
  has_address,
  currency_code,
  occurred_at,
  is_synthetic,
  updated_at
FROM brain_silver_local.brain_silver.silver_checkout_signal;
