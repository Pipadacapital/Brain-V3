-- ============================================================
-- Brain V4 Phase 4a — StarRocks serving layer (Silver)
-- mv_silver_order_line — ASYNC materialized view over Iceberg Silver
--   source: brain_silver_local.brain_silver.silver_order_line
--   serving DB: brain_serving
-- ADDITIVE / dual-run: app still reads dbt brain_silver.silver_order_line today.
-- Phase 4b repoints readers to brain_serving.mv_silver_order_line.
-- Money preserved as bigint minor units (unit_price_minor, line_total_minor,
-- line_discount_minor) + currency_code, never blended; brand_id present;
-- grain key = (brand_id, order_id, line_index).
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_silver_order_line
COMMENT "V4 serving MV over Iceberg Silver silver_order_line (per-currency minor-unit money)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  order_id,
  line_index,
  sku,
  title,
  quantity,
  unit_price_minor,
  line_total_minor,
  line_discount_minor,
  product_id,
  variant_id,
  currency_code,
  occurred_at
FROM brain_silver_local.brain_silver.silver_order_line;
