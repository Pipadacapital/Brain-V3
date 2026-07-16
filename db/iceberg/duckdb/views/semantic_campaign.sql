-- ============================================================
-- SPEC:D.1 — Semantic ENTITY view: semantic_campaign
--
-- Wave D semantic layer. UNIFIED across ad platforms, ONE ROW PER (brand, platform, campaign, currency),
-- a THIN COMPOSITION (no recompute) over:
--   • iceberg.brain_gold.gold_campaign_performance   — spend / impressions / clicks / ctr / cpc / roas
--       (impressions = reach where available)
--   • iceberg.brain_gold.gold_campaign_attribution   — DETERMINISTIC attributed revenue + order count
--       (§1.4 deterministic ledger; empty on golden today → attributed_* NULL = honest, not zero-inflated)
--   • iceberg.brain_gold.gold_attribution_credit ⋈ gold_order_economics.is_new_customer
--       — new-customer orders attributed to the campaign, for CAC(new).
--
-- ROAS  = roas_bps from gold_campaign_performance (attributed_minor / spend, bps). CAC(new) minor =
--   spend_minor / new_customer_orders_attributed (integer division; NULL when denominator 0 — honest).
-- Both are derived from integer facts; §1.2 permits decimal/bps ratios over integer inputs.
--
-- Money: spend_minor / attributed*_minor / cac_new_minor are bigint MINOR + currency_code, per-currency.
-- Grain: (brand_id, platform, campaign_id, currency_code). brand_id FIRST/tenant key; ${BRAND_PREDICATE}
-- seam at read (brand_id = ?); every join predicate is brand_id-keyed so the outer filter scopes all.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.semantic_campaign AS
SELECT
  p.brand_id,
  p.platform,
  p.campaign_id,
  p.campaign_name,
  p.currency_code,
  -- spend + reach
  p.spend_minor,
  p.impressions,                               -- reach where available
  p.clicks,
  p.ctr_bps,
  p.cpc_minor,
  p.roas_bps,                                  -- ROAS (bps)
  p.attributed_minor,                          -- perf-mart attributed proxy
  -- deterministic attribution (revenue + orders)
  a.attributed_revenue_minor,
  a.attributed_order_count,
  a.model_id AS attribution_model_id,
  -- CAC(new): spend / new-customer orders deterministically attributed to the campaign
  cn.new_customer_orders_attributed,
  CASE WHEN cn.new_customer_orders_attributed > 0
       -- `//` = DuckDB integer division (Trino's `/` truncated; plain `/` here would return DOUBLE)
       THEN p.spend_minor // cn.new_customer_orders_attributed
       ELSE NULL END AS cac_new_minor,
  p.updated_at
FROM iceberg.brain_gold.gold_campaign_performance p
LEFT JOIN iceberg.brain_gold.gold_campaign_attribution a
  ON  a.brand_id      = p.brand_id
 AND a.platform      = p.platform
 AND a.campaign_id   = p.campaign_id
 AND a.currency_code = p.currency_code
LEFT JOIN (
  -- distinct new-customer orders deterministically attributed to each campaign
  SELECT
    ac.brand_id,
    ac.campaign_id,
    count(DISTINCT ac.order_id) AS new_customer_orders_attributed
  FROM iceberg.brain_gold.gold_attribution_credit ac
  JOIN iceberg.brain_gold.gold_order_economics oe
    ON  oe.brand_id = ac.brand_id
   AND oe.order_id = ac.order_id
   AND oe.is_new_customer = true
  WHERE ac.row_kind = 'credit'
  GROUP BY ac.brand_id, ac.campaign_id
) cn ON cn.brand_id = p.brand_id AND cn.campaign_id = p.campaign_id;
