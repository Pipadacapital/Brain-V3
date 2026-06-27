-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_gold_retention
--
-- Brain V4 serving runs over TRINO (Iceberg). This view is the Trino
-- serving projection over the pre-materialized Iceberg mart that Spark builds
-- (iceberg.brain_gold.gold_retention). Serving is fast because Gold/Silver are already
-- materialized by Spark; the view is a column projection only (no compute).
-- Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Retention / repeat-purchase counts + integer-bps rates (NO money). Grain
-- (brand_id, cohort_month) — the acquisition cohort, row-for-row with mv_gold_cohorts.
-- Rates are EXACT integer basis points (×10000); divide by 10000 at the read seam
-- (the metric-engine computeRetention) to recover the decimal — never a stored float.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_retention;
-- with the Trino default catalog = iceberg that resolves to
-- iceberg.brain_serving.mv_gold_retention. brand_id is the tenant key; the
-- ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_retention AS
SELECT
  brand_id,
  cohort_month,
  currency_code,
  cohort_customers,
  repeat_customers,
  total_orders,
  repeat_orders,
  repeat_purchase_rate_bps,
  returning_customer_rate_bps,
  avg_orders_per_customer_bps,
  updated_at
FROM iceberg.brain_gold.gold_retention;
