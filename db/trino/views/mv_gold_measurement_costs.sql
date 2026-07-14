-- ============================================================
-- SPEC:C.2.4 — Trino serving VIEW: mv_gold_measurement_costs
-- Current-state projection over iceberg.brain_gold.gold_measurement_costs
-- (per-order COGS / shipping_forward / shipping_reverse (RTO) / packaging).
-- Money: amount_minor bigint MINOR + currency_code, per-currency, never blended.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_measurement_costs AS
SELECT
  brand_id,
  order_id,
  event_id,
  cost_type,
  amount_minor,
  currency_code,
  cost_confidence,
  source_system,
  source_event_id,
  occurred_at,
  updated_at
FROM iceberg.brain_gold.gold_measurement_costs;
