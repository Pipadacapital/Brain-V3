-- ============================================================
-- SPEC:D.1 — Semantic ENTITY view: semantic_product
--
-- Wave D semantic layer. ONE ROW PER PRODUCT, a THIN COMPOSITION (no recompute) over:
--   • iceberg.brain_gold.gold_product_detail     — catalog + performance (views/atc/purchases/revenue/returns)
--   • iceberg.brain_gold.gold_product_economics  — CM by product (CM1/CM2/CM3 summed across econ dates,
--       spec numbering per AMD-17), joined product_key = product_id (same Shopify product-id namespace)
--   • iceberg.brain_gold.gold_product_costs      — COST VALIDITY (cost_minor + valid_from/valid_to +
--       cost_confidence). Best-effort join on sku = CAST(product_id AS varchar); empty on golden today
--       → cost columns NULL = honest "no validated cost sheet", not a fabricated zero.
--
-- return_rate = return_count / purchases (ratio derived from integer counts — §1.2 allows decimal ratios).
-- rto_rate: NO per-product RTO source exists in the serving marts today (RTO is order-grain in
--   gold_cod_rto / gold_measurement_costs.shipping_reverse) → exposed as NULL (honest unknown), to be
--   populated additively when a per-product RTO rollup lands. Never a silent 0 that implies "no RTO".
--
-- Money: revenue_minor / *_minor / cost_minor are bigint MINOR + currency_code, per-currency, never blended.
-- Grain: one row per (brand_id, product_id). brand_id FIRST/tenant key; ${BRAND_PREDICATE} seam at read.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.semantic_product AS
SELECT
  d.brand_id,
  d.product_id,
  d.product_title,
  -- performance
  d.views,
  d.add_to_cart,
  d.purchases,
  d.revenue_minor,
  d.currency_code,
  d.add_to_cart_rate,
  d.purchase_rate,
  d.return_count,
  CASE WHEN d.purchases > 0
       THEN CAST(d.return_count AS double) / CAST(d.purchases AS double)
       ELSE NULL END AS return_rate,
  CAST(NULL AS double) AS rto_rate,           -- no per-product RTO source yet (honest unknown; additive later)
  -- CM by product (summed across econ dates)
  pe.econ_order_count,
  pe.econ_net_revenue_minor,
  pe.cogs_minor,
  pe.cm1_minor,
  pe.cm2_minor,
  pe.cm3_minor,
  -- cost validity (COGS cost-sheet)
  pc.cost_minor,
  pc.currency_code AS cost_currency_code,
  pc.valid_from    AS cost_valid_from,
  pc.valid_to      AS cost_valid_to,
  pc.cost_confidence,
  (pc.cost_minor IS NOT NULL) AS has_validated_cost,
  d.updated_at
FROM iceberg.brain_gold.gold_product_detail d
LEFT JOIN (
  SELECT
    pe.brand_id,
    pe.product_key,
    sum(pe.order_count)        AS econ_order_count,
    sum(pe.net_revenue_minor)  AS econ_net_revenue_minor,
    sum(pe.cogs_minor)         AS cogs_minor,
    sum(pe.cm1_minor)          AS cm1_minor,
    sum(pe.cm2_minor)          AS cm2_minor,
    sum(pe.cm3_minor)          AS cm3_minor
  FROM iceberg.brain_gold.gold_product_economics pe
  GROUP BY pe.brand_id, pe.product_key
) pe ON pe.brand_id = d.brand_id AND pe.product_key = d.product_id
-- currently-valid cost only (open interval: valid_to IS NULL)
LEFT JOIN iceberg.brain_gold.gold_product_costs pc
  ON pc.brand_id = d.brand_id
 AND pc.sku = CAST(d.product_id AS varchar)
 AND pc.valid_to IS NULL;
