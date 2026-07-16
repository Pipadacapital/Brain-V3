-- ============================================================
-- SPEC:C.2.2 — DuckDB serving VIEW: mv_gold_measurement_settlements
-- Current-state projection over iceberg.brain_gold.gold_measurement_settlements
-- (per-settlement-item gross/fees/net; reconciles vs the revenue ledger, C.5.4).
-- Money: gross/fees/net_minor bigint MINOR units + currency_code, per-currency.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_measurement_settlements AS
SELECT
  brand_id,
  order_id,
  event_id,
  settlement_batch_id,
  entity_type,
  gross_minor,
  fees_minor,
  net_minor,
  currency_code,
  reconciliation_type,
  settled_at,
  source_system,
  source_event_id,
  occurred_at,
  ingested_at,
  updated_at
FROM iceberg.brain_gold.gold_measurement_settlements;
