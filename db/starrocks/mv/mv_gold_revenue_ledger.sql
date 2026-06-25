-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer
-- mv_gold_revenue_ledger — ASYNC materialized view over Iceberg Gold
--   source: brain_gold_local.brain_gold.gold_revenue_ledger
--   serving DB: brain_serving
-- ADDITIVE / dual-run: app still reads dbt brain_gold.gold_revenue_ledger today.
-- Phase 4 repoints readers to brain_serving.mv_gold_revenue_ledger.
-- Money preserved as bigint minor units (amount_minor, fee_minor) + currency_code,
-- never blended; brand_id present; PK ledger_event_id preserved.
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_revenue_ledger
COMMENT "V4 serving MV over Iceberg Gold gold_revenue_ledger (per-currency minor-unit money)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  ledger_event_id,
  order_id,
  brain_id,
  event_type,
  amount_minor,
  currency_code,
  fee_minor,
  occurred_at,
  economic_effective_at,
  recognition_label,
  billing_posted_period,
  ingested_at,
  data_source,
  updated_at
FROM brain_gold_local.brain_gold.gold_revenue_ledger;
