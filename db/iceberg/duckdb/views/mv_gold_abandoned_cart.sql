-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_abandoned_cart
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- serving projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_abandoned_cart — db/iceberg/spark/gold/gold_abandoned_cart.py).
-- Serving is fast because Gold/Silver are already materialized by Spark; the view is a
-- column projection only (no compute). Redis fronts hot reads (analytics-cache.ts).
--
-- Abandoned-cart recovery surface. Grain (brand_id, cart_date, currency_code) — PER-CURRENCY
-- so abandoned_value never blends. MONEY: abandoned_value_minor is bigint MINOR units paired
-- with currency_code (never a float, never /100; the web formats via formatMoneyDisplay).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_abandoned_cart; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_abandoned_cart AS
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
