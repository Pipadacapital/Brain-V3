-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_product_affinity
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- serving projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_product_affinity — db/iceberg/spark/gold/gold_product_affinity.py).
-- Serving is fast because Gold/Silver are already materialized by Spark; the view is a
-- column projection only (no compute). Redis fronts hot reads (analytics-cache.ts).
--
-- Frequently-bought-together / co-purchase surface. Grain (brand_id, product_a, product_b),
-- product_a < product_b — for each unordered product pair, co_purchase_count = DISTINCT orders
-- containing BOTH, and support_pct = 100 * co_purchase_count / brand orders (2-dp ratio). NO money
-- (every measure is an order count or a count-derived ratio).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_product_affinity; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_product_affinity AS
SELECT
  brand_id,
  product_a,
  product_b,
  co_purchase_count,
  support_pct,
  updated_at
FROM iceberg.brain_gold.gold_product_affinity;
