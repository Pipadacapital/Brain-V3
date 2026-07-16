-- ============================================================
-- SPEC:C.2.3 — DuckDB serving VIEW: mv_gold_measurement_fees
-- Current-state projection over iceberg.brain_gold.gold_measurement_fees
-- (per-order payment/platform/checkout fees). Money: fee_minor bigint MINOR + currency.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_measurement_fees AS
SELECT
  brand_id,
  order_id,
  event_id,
  fee_type,
  fee_minor,
  currency_code,
  source_system,
  source_event_id,
  occurred_at,
  ingested_at,
  updated_at
FROM iceberg.brain_gold.gold_measurement_fees;
