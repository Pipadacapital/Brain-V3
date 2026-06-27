-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_customer_360
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_customer_360.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_customer_360). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Money: lifetime_value_minor bigint MINOR units + currency_code; per-(brand_id, currency_code), never blended. Grain (brand_id, brain_id).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_customer_360;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_customer_360. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_customer_360 AS
SELECT
  brand_id,
  brain_id,
  lifetime_orders,
  lifetime_value_minor,
  currency_code,
  first_seen_at,
  first_identified_at,
  last_seen_at,
  delivered_orders,
  rto_orders,
  cancelled_orders,
  refunded_orders,
  customer_watermark,
  updated_at
FROM iceberg.brain_gold.gold_customer_360;
