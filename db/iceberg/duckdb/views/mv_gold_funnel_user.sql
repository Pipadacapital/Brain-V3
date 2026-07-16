-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_funnel_user
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- serving projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_funnel_user). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts).
--
-- Per-VISITOR furthest funnel stage. Grain (brand_id, visitor_id) — one row per visitor
-- (visitor_id = the pixel brain_anon_id, upgraded to the stitched canonical brain_id when the
-- identity graph resolved one). reached_session / reached_product_view / reached_cart /
-- reached_checkout / reached_purchase are the per-step booleans; furthest_step is the deepest
-- reached_* in funnel order (session < product_view < cart < checkout < purchase). A funnel STEP
-- panel lists the visitors who DROPPED at a step via WHERE furthest_step = '<step>'.
--
-- NO money: this mart is funnel-stage identity bookkeeping (booleans + a step label).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_funnel_user; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_funnel_user AS
SELECT
  brand_id,
  visitor_id,
  reached_session,
  reached_product_view,
  reached_cart,
  reached_checkout,
  reached_purchase,
  furthest_step,
  last_seen_at,
  updated_at
FROM iceberg.brain_gold.gold_funnel_user;
