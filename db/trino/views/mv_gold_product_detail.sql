-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_product_detail
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- serving projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_product_detail). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts).
--
-- Per-PRODUCT performance. Grain (brand_id, product_id) — one row per product holding the full
-- storefront funnel: views (pixel product.viewed) → add_to_cart (pixel cart.viewed/item_added) →
-- purchases (order lines) → revenue_minor, plus return_count and the two conversion rates
-- (add_to_cart_rate / purchase_rate) as parity-safe 2dp STRINGS ('0.00' when views=0 — never 0/0).
--
-- MONEY: revenue_minor is BIGINT minor units paired with its sibling currency_code (per-currency,
-- never blended, never a float). currency_code is NULL for a views/cart-only product with 0 purchases.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_product_detail;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_product_detail. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_product_detail AS
SELECT
  brand_id,
  product_id,
  product_title,
  views,
  add_to_cart,
  purchases,
  revenue_minor,
  currency_code,
  return_count,
  add_to_cart_rate,
  purchase_rate,
  updated_at
FROM iceberg.brain_gold.gold_product_detail;
