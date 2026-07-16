-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_customer_list
--
-- DEDICATED customer-LIST projection (serving-layer Gap 4): the thin, list-shaped
-- slice of iceberg.brain_gold.gold_customer_360 that customer-list reads need —
-- deliberately EXCLUDING the wide per-customer payload columns (journey_summary,
-- watermark, first/last_seen) that mv_gold_customer_360 carries for the 360 drill-down.
-- A list page never pays for columns it doesn't render, and the list read surface is
-- pinned to an explicit contract (adding a 360 column can't widen every list scan).
--
-- Money: lifetime_value_minor + aov_minor are bigint MINOR units + sibling currency_code;
-- per-(brand_id, currency_code), never blended, never float. churn_score is a non-money
-- INTEGER 0-100. Grain (brand_id, brain_id).
--
-- KEYSET ORDER: list reads sort by (lifetime_value_minor DESC, brain_id ASC) — brain_id
-- is the unique tiebreak, so cursor pagination over this view is stable.
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_customer_list; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_customer_list AS
SELECT
  brand_id,
  brain_id,
  customer_ref,
  lifetime_orders,
  lifetime_value_minor,
  aov_minor,
  currency_code,
  delivered_orders,
  rto_orders,
  first_identified_at,
  preferred_channel,
  preferred_device,
  top_category,
  acquisition_source,
  health_band,
  churn_score,
  lifecycle_stage,
  last_activity_at
FROM iceberg.brain_gold.gold_customer_360;
