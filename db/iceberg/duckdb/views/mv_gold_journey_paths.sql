-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_journey_paths
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the thin serving
-- projection over the pre-materialized Iceberg Gold mart that Spark builds
-- (iceberg.brain_gold.gold_journey_paths — gold_journey_paths.py). It powers the
-- Journeys **Sankey**: the top-N most-common ordered CHANNEL paths per brand, each
-- with a per-path journey COUNT, the consecutive channel→channel edges[] the Sankey
-- draws, and a conversion count. Serving is fast because Gold is already materialized
-- by Spark; the view is a column projection only (no compute). Redis fronts hot reads.
--
-- NO money (a path is not monetary — mirrors mv_gold_attribution_paths).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_journey_paths; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
--
-- HOW THE SANKEY READS IT (Wire slice):
--   * Each row is ONE distinct ordered path (grain = brand_id, path_signature),
--     ranked path_rank = 1..N by journey_count desc within the brand.
--   * Sankey LINKS: UNNEST edges (array<row(step, from_channel, to_channel)>) across
--     the brand's rows and SUM journey_count grouped by (step, from_channel, to_channel).
--   * Per-step DROP-OFF at a node = journeys that REACHED it (Σ inbound, or Σ journey_count
--     of paths whose length > step) MINUS journeys that CONTINUED (Σ outbound at that step).
--   * channels (array<varchar>) is the ordered node sequence; first_touch_channel /
--     last_touch_channel are the endpoints; converted_count = paths that reached an order.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_journey_paths AS
SELECT
  brand_id,
  path_signature,
  path_length,
  channels,
  edges,
  first_touch_channel,
  last_touch_channel,
  journey_count,
  converted_count,
  path_rank,
  updated_at
FROM iceberg.brain_gold.gold_journey_paths;
