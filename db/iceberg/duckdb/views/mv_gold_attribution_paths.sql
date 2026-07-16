-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_attribution_paths
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- analogue of the (removed) StarRocks ASYNC MV db/starrocks/mv/mv_gold_attribution_paths.sql:
-- a THIN projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_attribution_paths). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Journey-path projection (no money). channel path + touch counts per stitched journey.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_attribution_paths; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_attribution_paths AS
SELECT
  brand_id,
  brain_anon_id,
  stitched_order_id,
  stitched_brain_id,
  channel_path,
  touch_count,
  distinct_channel_count,
  first_touch_channel,
  last_touch_channel,
  path_start_at,
  path_end_at,
  updated_at
FROM iceberg.brain_gold.gold_attribution_paths;
