-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_cohort_member
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is a THIN projection over the
-- pre-materialized Iceberg mart that Spark builds (iceberg.brain_gold.gold_cohort_member):
-- the USER-GRAIN companion to mv_gold_cohorts. Where mv_gold_cohorts is the aggregate
-- (one row per cohort_month), this is the per-CUSTOMER membership so a cohort CELL —
-- (acquisition month, months-since) — can be drilled into to list its active customers.
-- Serving is fast because Gold is already materialized by Spark; the view is a column
-- projection only (no compute). Redis fronts hot reads (analytics-cache.ts).
--
-- NO money: counts/identity only (active membership + order_count_in_period). The cohort
-- value/size aggregate lives in mv_gold_cohorts.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_cohort_member; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_cohort_member AS
SELECT
  brand_id,
  customer_key,
  cohort_month,
  period_index,
  active,
  order_count_in_period,
  updated_at
FROM iceberg.brain_gold.gold_cohort_member;
