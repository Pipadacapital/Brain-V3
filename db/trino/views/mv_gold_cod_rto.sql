-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_cod_rto
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_cod_rto.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_cod_rto). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Money: cod_amount_minor bigint MINOR units + currency_code, per-currency, never blended.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_cod_rto;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_cod_rto. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_cod_rto AS
SELECT
  brand_id,
  currency_code,
  cod_orders,
  cod_amount_minor,
  predicted_rto,
  actual_delivered,
  actual_rto,
  resolved,
  rto_rate_bps,
  prediction_correct,
  prediction_evaluated,
  prediction_accuracy_bps,
  updated_at
FROM iceberg.brain_gold.gold_cod_rto;
