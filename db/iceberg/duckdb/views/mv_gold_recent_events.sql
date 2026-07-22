-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_recent_events
--
-- ADR-0018 F4/D4: the pre-baked top-N recent-events RING for the Tracking-Center Event Explorer.
-- A THIN projection over the pre-materialized Iceberg mart the transform tier builds
-- (iceberg.brain_gold.gold_recent_events — gold_recent_events.py). Serving is fast because the
-- expensive ROW_NUMBER() top-N sort already ran in Gold; this view is a column projection only
-- (no compute). It REPLACES the operational-read full-scan of the growing keystone
-- mv_silver_collector_event (get-recent-events.ts) — the last single-query-ceiling violation on
-- these reads. Redis fronts hot reads (analytics-cache.ts).
--
-- Grain (brand_id, event_id) — the newest 200 events per brand by occurred_at (200, not the
-- endpoint's 50 cap, so ≥50 PIXEL rows survive the endpoint's post-read pixel-only filter).
-- is_pixel is PRECOMPUTED so the endpoint filters on a boolean, not a string IN-list scan.
-- details_json carries the raw `properties` object; the read side (get-recent-events.safeDetails)
-- drops PII-keyed + empty values before it leaves core (ADR-2 / I-S02). No money.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_recent_events; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is attached as
-- `iceberg`; local views shadow its namespace). brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_recent_events AS
SELECT
  brand_id,
  event_id,
  event_type,
  occurred_at,
  ingested_at,
  anon_id,
  session_id,
  has_consent,
  details_json,
  is_pixel,
  updated_at
FROM iceberg.brain_gold.gold_recent_events;
