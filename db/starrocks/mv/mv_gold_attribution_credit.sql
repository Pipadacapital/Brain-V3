-- mv_gold_attribution_credit.sql — Brain V4 Phase 3 serving layer (ADDITIVE / dual-run).
--
-- StarRocks ASYNC MATERIALIZED VIEW that serves the Iceberg Gold attribution-credit ledger
-- (brain_gold_local.brain_gold.gold_attribution_credit) FROM the internal serving DB brain_serving.
-- This is the V4 path: StarRocks serves business truth FROM Iceberg Gold, not from the dbt internal
-- brain_gold base tables. NON-BREAKING: the app still reads brain_gold today; Phase 4 repoints readers.
--
-- Every column of the source mart is preserved, including:
--   credited_revenue_minor  — SIGNED BIGINT minor units (+credit / -clawback; never float, never blended)
--   realized_revenue_minor  — SIGNED BIGINT minor units
--   currency_code           — per-currency money is NEVER blended across currencies
--   brand_id                — tenant key (distribution key; per-brand isolation anchor)
--   credit_id               — the deterministic sha256 mart PK (PRIMARY KEY (brand_id, credit_id))
--
-- DISTRIBUTED BY HASH(brand_id): co-locates a brand's credits; matches the source mart's distribution.
-- REFRESH ASYNC every 5 min: pulls new Iceberg Gold snapshots without blocking; honest 0 rows builds fine.

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_attribution_credit
DISTRIBUTED BY HASH(brand_id) BUCKETS 8
REFRESH ASYNC START('2026-01-01 00:00:00') EVERY (INTERVAL 5 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
SELECT
  brand_id,
  credit_id,
  order_id,
  brain_anon_id,
  touch_seq,
  channel,
  campaign_id,
  model_id,
  row_kind,
  weight_fraction,
  credited_revenue_minor,
  currency_code,
  reversed_of_credit_id,
  reversal_reason,
  realized_revenue_minor,
  confidence_grade,
  attribution_confidence,
  model_version,
  metric_snapshot_id,
  occurred_at,
  economic_effective_at,
  billing_posted_period,
  updated_at
FROM brain_gold_local.brain_gold.gold_attribution_credit;
