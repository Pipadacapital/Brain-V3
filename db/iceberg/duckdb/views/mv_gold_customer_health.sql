-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_customer_health
--
-- DR-005: gold_customer_health (the mart) is RETIRED — its deterministic recency/frequency
-- health surface is computed INLINE by gold_customer_360.py and carried on gold_customer_360.
-- This view keeps the EXACT reader contract (insights briefing, ML platform, freshness probe)
-- as a thin projection of the 360, filtered to the old mart's grain (customers WITH orders —
-- last_order_at NOT NULL; the 360 spine also carries order-less identified customers).
--
-- The metric-engine reads this as brain_serving.mv_gold_customer_health; brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_customer_health AS
SELECT
  brand_id,
  brain_id,
  recency_days,
  frequency,
  health_score,
  health_band,
  last_order_at,
  lifetime_value_minor,
  currency_code,
  updated_at
FROM iceberg.brain_gold.gold_customer_360
WHERE last_order_at IS NOT NULL;
