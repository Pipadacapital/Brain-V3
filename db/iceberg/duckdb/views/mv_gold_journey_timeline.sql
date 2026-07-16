-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_journey_timeline
--
-- DEDICATED journey-TIMELINE projection (serving-layer Gap 4): exactly the per-touch
-- columns the Customer-360 journey timeline renders, over the Spark-materialized
-- iceberg.brain_silver.silver_touchpoint mart. The timeline read no longer rides the
-- full-width mv_silver_touchpoint (which carries session/page/click-id columns the
-- timeline never renders) — the timeline read surface is pinned to its own contract.
-- (Named mv_gold_* because it SERVES a Gold-tier product surface — the Customer-360
-- timeline — even though its source mart is the Silver touchpoint spine.)
--
-- No money. Grain (brand_id, brain_anon_id, touch_seq); readers ORDER BY touch_seq.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_journey_timeline; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_journey_timeline AS
SELECT
  brand_id,
  brain_anon_id,
  touch_seq,
  is_first_touch,
  is_last_touch,
  occurred_at,
  event_type,
  channel,
  utm_source,
  utm_medium,
  utm_campaign,
  utm_term,
  utm_content,
  fbclid,
  gclid,
  ttclid,
  referrer_host,
  landing_path,
  stitched_order_id,
  stitched_brain_id
FROM iceberg.brain_silver.silver_touchpoint;
