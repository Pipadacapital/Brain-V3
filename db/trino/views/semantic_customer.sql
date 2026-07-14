-- ============================================================
-- SPEC:D.1 — Semantic ENTITY view: semantic_customer
--
-- Wave D semantic layer. A THIN COMPOSITION (no recompute) over already-materialized
-- Gold marts + the sanctioned identity accessor:
--   • iceberg.brain_gold.gold_customer_360      — customer spine (LTV, orders, lifecycle, journey_summary)
--   • iceberg.brain_serving.identity_current_v  — SANCTIONED identity accessor (A.2.2/AMD-07); the
--       identity timeline summary (identifier types currently present + count) is aggregated from it.
--       NEVER read iceberg.brain_silver.silver_identity_map directly (identity-view-guard).
--   • iceberg.brain_gold.gold_customer_scores   — RFM segment membership (recency/frequency/monetary/churn_risk)
--
-- identity_basis: gold_customer_360 is built from the DETERMINISTIC identity spine only
-- (§1.4 — probabilistic links are physically segregated and never reach revenue/customer facts),
-- so every attribute here is deterministic → identity_basis = 'deterministic' (constant, honest).
-- Any future probabilistic-derived attribute would carry its own basis flag + estimated:true at the gateway.
--
-- Money: lifetime_value_minor / aov_minor / lifetime_value_minor(scores) are bigint MINOR units +
-- sibling currency_code, per-(brand_id, currency_code), never blended, never float.
-- Grain: one row per (brand_id, brain_id). brand_id is the FIRST/tenant key; consumers read through
-- the ${BRAND_PREDICATE} seam (withTrinoBrand → brand_id = ?) — Trino REST has no row policy (AMD-07 D3),
-- the predicate injection IS the compile-time tenancy. Every join predicate is brand_id-keyed so the
-- outer brand filter scopes the whole composition.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.semantic_customer AS
SELECT
  c.brand_id,
  c.brain_id,
  c.customer_ref,
  -- economics / lifetime (from gold_customer_360)
  c.lifetime_orders,
  c.lifetime_value_minor,
  c.aov_minor,
  c.currency_code,
  c.delivered_orders,
  c.rto_orders,
  c.cancelled_orders,
  c.refunded_orders,
  -- identity timeline (first/last identified) — from the customer spine
  c.first_seen_at,
  c.first_identified_at,
  c.last_seen_at,
  c.last_activity_at,
  -- identity timeline summary (identifier TYPES currently present + count) — from the sanctioned accessor
  ic.identifier_types_present,
  ic.identifier_count,
  -- behavioural / acquisition enrichment
  c.preferred_channel,
  c.preferred_device,
  c.top_category,
  c.acquisition_source,
  c.health_band,
  c.churn_score,
  c.lifecycle_stage,
  c.journey_summary,
  -- segment memberships (RFM) — from gold_customer_scores
  s.recency_score,
  s.frequency_score,
  s.monetary_score,
  s.churn_risk,
  -- identity_basis: deterministic spine only (§1.4). Constant, but explicit + honest.
  CAST('deterministic' AS varchar) AS identity_basis,
  c.updated_at
FROM iceberg.brain_gold.gold_customer_360 c
LEFT JOIN (
  -- Identifier types + count currently mapped to this brain_id, via the SANCTIONED accessor.
  SELECT
    iv.brand_id,
    iv.brain_id,
    array_agg(DISTINCT iv.identifier_type) AS identifier_types_present,
    count(DISTINCT iv.identifier_hash)     AS identifier_count
  FROM iceberg.brain_serving.identity_current_v iv
  GROUP BY iv.brand_id, iv.brain_id
) ic ON ic.brand_id = c.brand_id AND ic.brain_id = c.brain_id
LEFT JOIN iceberg.brain_gold.gold_customer_scores s
  ON s.brand_id = c.brand_id AND s.brain_id = c.brain_id;
