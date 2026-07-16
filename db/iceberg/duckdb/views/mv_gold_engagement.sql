-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_engagement
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- serving projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_engagement — db/iceberg/spark/gold/gold_engagement.py).
-- Serving is fast because Gold/Silver are already materialized by Spark; the view is a
-- column projection only (no compute). Redis fronts hot reads (analytics-cache.ts).
--
-- Storefront engagement surface. Grain (brand_id, engagement_date, signal_type) — daily
-- count of pixel engagement signals (scroll/video/exit_intent/clicks/…) with session +
-- page reach and average scroll depth. NO money (engagement is signal counting; every
-- measure is a count, except avg_scroll_pct which is a 0–100 percentage).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_engagement; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_engagement AS
SELECT
  brand_id,
  engagement_date,
  signal_type,
  signal_count,
  sessions,
  pages,
  avg_scroll_pct,
  updated_at
FROM iceberg.brain_gold.gold_engagement;
