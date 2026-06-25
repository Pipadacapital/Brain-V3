-- ============================================================
-- Brain V4 Phase 4a — StarRocks serving layer (Silver)
-- mv_silver_shipment — ASYNC materialized view over Iceberg Silver
--   source: brain_silver_local.brain_silver.silver_shipment
--   serving DB: brain_serving
-- ADDITIVE / dual-run: app still reads dbt brain_silver.silver_shipment today.
-- Phase 4b repoints readers to brain_serving.mv_silver_shipment.
-- No money columns; brand_id present; grain key = (brand_id, order_id, source).
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_silver_shipment
COMMENT "V4 serving MV over Iceberg Silver silver_shipment"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  order_id,
  source,
  awb_number_hash,
  courier,
  current_status,
  terminal_class,
  is_terminal,
  is_rto,
  is_delivered,
  payment_method,
  pincode,
  first_event_at,
  last_status_at,
  is_synthetic,
  updated_at
FROM brain_silver_local.brain_silver.silver_shipment;
