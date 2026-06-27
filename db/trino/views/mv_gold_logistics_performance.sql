-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_logistics_performance
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_logistics_performance.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_logistics_performance). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Shipment counters + bps rates (no money). Source PK (brand_id, courier). May serve 0 rows.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_logistics_performance;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_logistics_performance. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_logistics_performance AS
SELECT
  brand_id,
  courier,
  shipments,
  delivered,
  rto,
  other_terminal,
  in_transit,
  resolved,
  delivery_rate_bps,
  rto_rate_bps,
  updated_at
FROM iceberg.brain_gold.gold_logistics_performance;
