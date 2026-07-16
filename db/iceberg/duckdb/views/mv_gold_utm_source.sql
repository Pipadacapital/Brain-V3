-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_utm_source
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the DuckDB
-- serving projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_utm_source). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts).
--
-- The UTM / acquisition-SOURCE matrix. Grain (brand_id, source, medium) — one row per
-- first-touch (utm_source, utm_medium): visitors, conversions, revenue_minor, avg_ltv_minor,
-- repeat_rate_pct. source / medium collapse honest-empty dims to 'unknown'.
--
-- MONEY: revenue_minor + avg_ltv_minor are bigint MINOR units paired with currency_code
-- (per-currency, NEVER blended — each is summed/averaged within the group's single currency).
-- repeat_rate_pct is an integer 0-100.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_utm_source; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_utm_source AS
SELECT
  brand_id,
  source,
  medium,
  visitors,
  conversions,
  revenue_minor,
  avg_ltv_minor,
  repeat_rate_pct,
  currency_code,
  updated_at
FROM iceberg.brain_gold.gold_utm_source;
