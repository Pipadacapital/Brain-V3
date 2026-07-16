-- ============================================================
-- SPEC:C.2.1 — DuckDB serving VIEW: mv_gold_measurement_refunds
-- Derived current-state projection over the append-only Iceberg fact
-- iceberg.brain_gold.gold_measurement_refunds (refunds + RTO returns).
-- Money: amount_minor bigint MINOR units + currency_code, per-currency, never blended.
-- Grain (brand_id, order_id, event_id); source_system/source_event_id = lineage.
-- brand_id is the tenant key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_measurement_refunds AS
SELECT
  brand_id,
  order_id,
  event_id,
  order_line_id,
  amount_minor,
  currency_code,
  reason_code,
  refund_method,
  initiated_at,
  settled_at,
  source_system,
  source_event_id,
  occurred_at,
  ingested_at,
  updated_at
FROM iceberg.brain_gold.gold_measurement_refunds;
