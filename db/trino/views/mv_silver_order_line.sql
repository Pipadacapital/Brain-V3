-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_silver_order_line
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_silver_order_line.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_silver.silver_order_line). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Money: unit_price_minor / line_total_minor / line_discount_minor bigint MINOR units + currency_code, never blended. Grain (brand_id, order_id, line_index).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_silver_order_line;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_silver_order_line. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_silver_order_line AS
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
FROM iceberg.brain_silver.silver_order_line;
