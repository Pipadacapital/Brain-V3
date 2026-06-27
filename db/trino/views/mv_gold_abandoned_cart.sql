-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_abandoned_cart
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_abandoned_cart.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_abandoned_cart). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Money: abandoned_value_minor is bigint MINOR units + currency_code, per-currency, never blended.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_abandoned_cart;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_abandoned_cart. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_abandoned_cart AS
SELECT
  brand_id,
  cart_date,
  currency_code,
  cart_sessions,
  abandoned_carts,
  recovered_carts,
  abandoned_value_minor,
  updated_at
FROM iceberg.brain_gold.gold_abandoned_cart;
