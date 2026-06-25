-- ============================================================
-- Brain V4 Phase 3 — StarRocks serving layer (ADDITIVE / dual-run)
-- mv_gold_abandoned_cart
--
-- ASYNC materialized view that serves business truth FROM the Iceberg Gold
-- mart brain_gold_local.brain_gold.gold_abandoned_cart via the external
-- Iceberg catalog. V4 serving path: StarRocks serves Gold FROM Iceberg, NOT
-- the dbt internal brain_gold base table. Readers NOT repointed (Phase 4).
--
-- One-way rule (ADR-002): Iceberg -> dbt -> StarRocks -> API. Read-only MV.
--
-- Money: abandoned_value_minor is bigint MINOR units, paired with
-- currency_code, per-currency, never blended. brand_id + grain
-- (brand_id, cart_date) preserved.
-- ============================================================

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_abandoned_cart
COMMENT "V4 serving MV over Iceberg Gold gold_abandoned_cart (per-currency abandoned value, minor units)"
DISTRIBUTED BY HASH(brand_id)
REFRESH ASYNC EVERY (INTERVAL 30 MINUTE)
AS
SELECT
  brand_id,
  cart_date,
  currency_code,
  cart_sessions,
  abandoned_carts,
  recovered_carts,
  abandoned_value_minor,
  updated_at
FROM brain_gold_local.brain_gold.gold_abandoned_cart;
