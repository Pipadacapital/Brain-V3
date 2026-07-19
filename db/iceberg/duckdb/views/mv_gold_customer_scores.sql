-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_customer_scores
--
-- DR-005: gold_customer_scores (the mart) is RETIRED — the deterministic RFM/churn scoring is
-- computed INLINE by gold_customer_360.py (verbatim thresholds) and carried on gold_customer_360.
-- This view keeps the EXACT reader contract: scored_on = the 360's compute date, computed_at =
-- the 360's write clock, data_source = 'live' (the only value the retired mart ever emitted).
--
-- Money: lifetime_value_minor + currency_code, never blended. Grain (brand_id, brain_id).
-- The metric-engine reads this as brain_serving.mv_gold_customer_scores; brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_customer_scores AS
SELECT
  brand_id,
  brain_id,
  currency_code,
  CAST(updated_at AS DATE) AS scored_on,
  lifetime_orders,
  lifetime_value_minor,
  days_since_last_order,
  recency_score,
  frequency_score,
  monetary_score,
  churn_risk,
  'live' AS data_source,
  updated_at AS computed_at
FROM iceberg.brain_gold.gold_customer_360;
