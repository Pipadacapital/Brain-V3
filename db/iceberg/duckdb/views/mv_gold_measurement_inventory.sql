-- ============================================================
-- SPEC:C.2.6 — DuckDB serving VIEW: mv_gold_measurement_inventory
-- Current-state projection over iceberg.brain_gold.gold_measurement_inventory
-- (flag-gated per-brand inventory MOVEMENT fact; movement_qty = quantity - prev_quantity).
-- No money (stock is a count). Empty for brands with measurement.inventory_movement OFF.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_measurement_inventory AS
SELECT
  brand_id,
  product_id,
  variant_id,
  event_id,
  observed_at,
  prev_quantity,
  quantity,
  movement_qty,
  source,
  source_event_id,
  updated_at
FROM iceberg.brain_gold.gold_measurement_inventory;
