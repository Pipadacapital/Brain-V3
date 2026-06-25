-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer (ADDITIVE / dual-run)
-- mv_gold_contribution_margin
--
-- ASYNC materialized view that serves business truth FROM the Iceberg Gold
-- mart brain_gold_local.brain_gold.gold_contribution_margin (Spark/dbt-built,
-- read via the external Iceberg catalog). This is the V4 serving path:
-- StarRocks serves Gold FROM Iceberg, NOT from the dbt internal brain_gold
-- base table. Readers are NOT repointed here (Phase 4 does that).
--
-- One-way rule (ADR-002): Iceberg -> dbt -> StarRocks -> API. The MV only
-- READS the external Iceberg catalog; no StarRocks -> Iceberg write.
--
-- Money: bigint MINOR units + currency_code preserved verbatim, per-currency,
-- never blended. brand_id + the mart grain (brand_id, currency_code,
-- as_of_date) preserved.
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_contribution_margin
COMMENT "V4 serving MV over Iceberg Gold gold_contribution_margin (per-currency CM1/CM2, minor units)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 30 MINUTE)
AS
SELECT
  brand_id,
  currency_code,
  as_of_date,
  net_revenue_minor,
  cogs_minor,
  variable_minor,
  cm1_minor,
  marketing_minor,
  cm2_minor,
  cost_confidence,
  updated_at
FROM brain_gold_local.brain_gold.gold_contribution_margin;
