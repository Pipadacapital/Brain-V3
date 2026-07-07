-- ============================================================
-- SPEC:C.2.5 / C.4 — Trino serving VIEW: mv_gold_measurement_spend
--
-- AMD-16 R1 (BINDING): marketing spend is ALREADY a canonical day×channel×campaign fact —
-- iceberg.brain_silver.silver_marketing_spend (LIVE 30k+ rows, consumed by CAC/campaign/CM).
-- A second greenfield gold_measurement_spend copy would duplicate a live fact and carry a
-- permanent parity burden, so per AMD-16 spend is exposed as a VIEW ALIAS into the measurement
-- namespace — the SILVER TABLE remains the single fact.
--
-- ADDITIVE / SUPERSET (§0.5): this view exposes EVERY column mv_silver_marketing_spend exposes
-- UNCHANGED (so a C.4 reader that swaps FROM mv_silver_marketing_spend → mv_gold_measurement_spend
-- behind the measurement.marts_migration flag sees BYTE-IDENTICAL spend — no spend delta, no revenue
-- delta) AND ADDS the measurement-fact lineage aliases the C.2 fact contract standardises on:
--   source_event_id  ← spend_event_id   (the Bronze idempotency key / grain)
--   source_system    ← platform         (meta | google_ads | …)
-- Never a rename-away: the original `platform` / `spend_event_id` columns are retained so existing
-- consumers keep working and the flag switch is transparent.
--
-- Money: spend_minor bigint MINOR units + currency_code, per-currency, never blended.
-- brand_id is the tenant key; ${BRAND_PREDICATE} injects brand_id = ? at read.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_measurement_spend AS
SELECT
  brand_id,
  spend_event_id,
  platform,
  level,
  level_id,
  parent_id,
  campaign_id,
  campaign_name,
  stat_date,
  spend_minor,
  currency_code,
  impressions,
  clicks,
  conversions,
  conv_value_minor,
  account_timezone,
  occurred_at,
  updated_at,
  -- ── measurement lineage aliases (AMD-16) — ADDITIVE, alongside the originals ──
  spend_event_id AS source_event_id,
  platform       AS source_system
FROM iceberg.brain_silver.silver_marketing_spend;
