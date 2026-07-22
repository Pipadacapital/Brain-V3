-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_channel_roas
--
-- ADR-0019 WS-3 D6: the pre-baked per-channel ROAS mart (gold_channel_roas.py). Moves the read-time
-- FX-blend computeChannelRoas did (attribution × spend at read time) into the transform tier per the
-- single-query-ceiling doctrine. This THIN projection over the pre-materialized Iceberg mart
-- (iceberg.brain_gold.gold_channel_roas) is a served read; get-channel-roas.ts repoints behind
-- SERVING_CHANNEL_ROAS_FROM_MART (default OFF → today's live recompute). Serving is a column projection
-- only (no compute).
--
-- Grain (brand_id, model_id, channel, currency_code, stat_date) — DAILY so the endpoint sums the two
-- exact BIGINT operands over any [from, to] window and derives the ratio at read (a ratio is
-- non-additive, so it is NEVER precomputed). Money: attributed_minor / spend_minor are bigint MINOR
-- units + the sibling currency_code, per-currency, never blended, never a float.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_channel_roas; in duckdb-serving
-- that resolves to this LOCAL view (the Iceberg REST catalog is attached as `iceberg`; local views shadow
-- its namespace). brand_id is the tenant key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read
-- time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_channel_roas AS
SELECT
  brand_id,
  model_id,
  channel,
  currency_code,
  stat_date,
  attributed_minor,
  spend_minor,
  data_source,
  updated_at
FROM iceberg.brain_gold.gold_channel_roas;
