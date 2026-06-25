-- mv_gold_attribution_paths.sql — Brain V4 Phase 3 serving layer (ADDITIVE / dual-run).
--
-- StarRocks ASYNC MATERIALIZED VIEW serving the Iceberg Gold attribution-paths mart
-- (brain_gold_local.brain_gold.gold_attribution_paths) FROM the internal serving DB brain_serving.
-- V4 path: StarRocks serves business truth FROM Iceberg Gold (not the dbt internal brain_gold table).
-- NON-BREAKING: the app still reads brain_gold today; Phase 4 repoints readers. Honest 0 rows builds fine.
--
-- This mart is a journey-path projection (no money columns) — it carries the channel path + touch
-- counts per stitched journey. brand_id (tenant key) is the distribution key; the natural mart key is
-- (brand_id, stitched_order_id / stitched_brain_id, brain_anon_id). Every source column is preserved.

CREATE DATABASE IF NOT EXISTS brain_serving;

CREATE MATERIALIZED VIEW IF NOT EXISTS brain_serving.mv_gold_attribution_paths
DISTRIBUTED BY HASH(brand_id) BUCKETS 8
REFRESH ASYNC START('2026-01-01 00:00:00') EVERY (INTERVAL 5 MINUTE)
PROPERTIES (
  "replication_num" = "1"
)
AS
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
FROM brain_gold_local.brain_gold.gold_attribution_paths;
