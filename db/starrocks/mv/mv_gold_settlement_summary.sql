-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving MV: mv_gold_settlement_summary
-- ADDITIVE / dual-run. Serves business truth FROM Iceberg Gold
-- (brain_gold_local.brain_gold.gold_settlement_summary) via an async
-- materialized view in the internal serving DB brain_serving. Does NOT touch
-- dbt brain_gold base tables or any reader (Phase 4 repoints readers).
--
-- ADR-002 one-way rule: Iceberg -> dbt -> StarRocks -> Analytics API.
--
-- Source PK: (brand_id, currency_code)
-- Money: minor units (gross/fee/tax/refund/dispute/net _minor) + currency_code.
--        Per-currency, never blended. May be 0 rows when upstream Silver
--        settlement is empty — the MV must build + serve 0 rows.
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_settlement_summary
DISTRIBUTED BY HASH(brand_id) BUCKETS 4
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  currency_code,
  settlements,
  gross_minor,
  fee_minor,
  tax_minor,
  refund_minor,
  dispute_minor,
  net_minor,
  updated_at
FROM brain_gold_local.brain_gold.gold_settlement_summary;
