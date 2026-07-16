-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_gold_campaign_attribution
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the per-CAMPAIGN, per-MODEL
-- attributed-revenue + ROAS surface (#32c): a THIN projection over the pre-materialized
-- Iceberg mart that Spark builds (iceberg.brain_gold.gold_campaign_attribution). Serving is
-- fast because Gold/Silver are already materialized by Spark; the view is a column projection
-- only (no compute). Redis fronts hot reads (analytics-cache.ts; wired in phase 2).
--
-- Grain: one row per (brand_id, platform, campaign_id, model_id, currency_code). The read layer
-- picks a default attribution model (e.g. position_based) and lets the user switch models.
--
-- Money: attributed_revenue_minor + spend_minor are bigint MINOR units sharing currency_code
-- (never blended, never float). roas_bps is integer BASIS POINTS (read-time ratio = roas_bps / 10000.0);
-- NULL when spend_minor = 0 (honest — never a fabricated ∞).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_gold_campaign_attribution; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_gold_campaign_attribution AS
SELECT
  brand_id,
  platform,
  campaign_id,
  model_id,
  currency_code,
  campaign_name,
  attributed_revenue_minor,
  spend_minor,
  attributed_order_count,
  roas_bps,
  updated_at
FROM iceberg.brain_gold.gold_campaign_attribution;
