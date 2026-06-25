-- mv_snap_attribution_credit.sql — Brain V4 Phase 3 serving layer (ADDITIVE / dual-run).
--
-- StarRocks ASYNC MATERIALIZED VIEW serving the Iceberg attribution-credit daily SNAPSHOT mart
-- FROM the internal serving DB brain_serving.
--
-- SOURCE LOCATION NOTE: snap_attribution_credit physically lives in the Iceberg SILVER namespace
-- (brain_silver_local.brain_silver.snap_attribution_credit), not the Gold namespace — it is the
-- point-in-time snapshot grain (partitioned by snapshot_date) that the Gold attribution surfaces
-- roll up from. The MV serves the mart faithfully from wherever its Iceberg source lives.
-- V4 path: StarRocks serves business truth FROM Iceberg (not a dbt internal base table).
-- NON-BREAKING: the app still reads its current sources today; Phase 4 repoints readers.
-- Honest 0 rows builds + serves fine.
--
-- Money preserved as SIGNED BIGINT minor units, per-currency, NEVER blended:
--   credited_revenue_minor + currency_code.
-- brand_id (tenant key) is the distribution key; (brand_id, credit_id, snapshot_date) is the mart key.

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_snap_attribution_credit
DISTRIBUTED BY HASH(brand_id) BUCKETS 8
REFRESH ASYNC START('2026-01-01 00:00:00') EVERY (INTERVAL 5 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  credit_id,
  snapshot_date,
  order_id,
  channel,
  campaign_id,
  model_id,
  model_version,
  row_kind,
  credited_revenue_minor,
  currency_code,
  confidence_grade,
  occurred_at,
  computed_at
FROM brain_silver_local.brain_silver.snap_attribution_credit;
