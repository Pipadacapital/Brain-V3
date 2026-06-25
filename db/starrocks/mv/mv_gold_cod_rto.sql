-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer (ADDITIVE / dual-run)
-- mv_gold_cod_rto
--
-- ASYNC materialized view that serves business truth FROM the Iceberg Gold
-- mart brain_gold_local.brain_gold.gold_cod_rto via the external Iceberg
-- catalog. V4 serving path: StarRocks serves Gold FROM Iceberg, NOT the dbt
-- internal brain_gold base table. Readers are NOT repointed here (Phase 4).
--
-- One-way rule (ADR-002): Iceberg -> dbt -> StarRocks -> API. Read-only MV.
--
-- Money: cod_amount_minor is bigint MINOR units, paired with currency_code,
-- per-currency, never blended. brand_id + grain (brand_id, currency_code)
-- preserved.
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_cod_rto
COMMENT "V4 serving MV over Iceberg Gold gold_cod_rto (per-currency COD/RTO, minor units)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 30 MINUTE)
AS
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
FROM brain_gold_local.brain_gold.gold_cod_rto;
