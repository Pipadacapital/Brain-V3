-- ============================================================
-- SPEC:C.2.4 — DuckDB serving VIEW: mv_gold_product_costs
-- Per-SKU COGS dimension over iceberg.brain_gold.gold_product_costs.
-- Money: cost_minor bigint MINOR + currency_code, per-currency. valid_from/valid_to interval.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_product_costs AS
SELECT
  brand_id,
  sku,
  cost_minor,
  currency_code,
  valid_from,
  valid_to,
  cost_confidence,
  source_system,
  source_event_id,
  updated_at
FROM iceberg.brain_gold.gold_product_costs;
