-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer
-- mv_gold_cac — ASYNC materialized view over Iceberg Gold
--   source: brain_gold_local.brain_gold.gold_cac
--   serving DB: brain_serving
-- ADDITIVE / dual-run: app still reads dbt brain_gold.gold_cac today.
-- Money preserved as bigint minor units (acquisition_spend_minor) + currency_code,
-- never blended; brand_id present; grain key = (brand_id, acquisition_month, currency_code).
-- ============================================================
CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_cac
COMMENT "V4 serving MV over Iceberg Gold gold_cac (per-currency minor-unit money)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  acquisition_month,
  currency_code,
  new_customers,
  acquisition_spend_minor,
  data_source,
  updated_at
FROM brain_gold_local.brain_gold.gold_cac;
