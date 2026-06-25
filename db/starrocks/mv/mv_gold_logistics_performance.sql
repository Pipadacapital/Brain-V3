-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving MV: mv_gold_logistics_performance
-- ADDITIVE / dual-run. Serves business truth FROM Iceberg Gold
-- (brain_gold_local.brain_gold.gold_logistics_performance) via an async
-- materialized view in the internal serving DB brain_serving. Does NOT touch
-- dbt brain_gold base tables or any reader (Phase 4 repoints readers).
--
-- ADR-002 one-way rule: Iceberg -> dbt -> StarRocks -> Analytics API.
--
-- Source PK: (brand_id, courier)
-- Money: none (shipment counters + bps rates). May be 0 rows when upstream
--        Silver logistics is empty — the MV must build + serve 0 rows.
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_logistics_performance
DISTRIBUTED BY HASH(brand_id) BUCKETS 4
REFRESH ASYNC EVERY (INTERVAL 15 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  courier,
  shipments,
  delivered,
  rto,
  other_terminal,
  in_transit,
  resolved,
  delivery_rate_bps,
  rto_rate_bps,
  updated_at
FROM brain_gold_local.brain_gold.gold_logistics_performance;
