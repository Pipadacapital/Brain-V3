-- ============================================================
-- SPEC:D.1 — Semantic ENTITY view: semantic_journey
--
-- Wave D semantic layer. ALIASES the Wave-B canonical journey entity (iceberg.brain_gold.journey_events —
-- the versioned, event-sourced journey ledger with matched_via + identity_basis + bi-temporal brain_id_asof)
-- into the semantic_* namespace, so dashboards / APIs / BAI / agents address journeys through one governed
-- entity name alongside semantic_customer/order/product/campaign. Pure projection — no recompute; identical
-- column semantics to brain_serving.mv_journey_events_current (the Wave-B serving view).
--
-- identity_basis = 'deterministic' on the canonical ledger (§1.4 — probabilistic overlays live in a
-- separate view, never blended here). matched_via carries the identity-link provenance per touchpoint
-- (the B.3 trace/explainability surface).
--
-- Money: revenue_minor is bigint MINOR + currency_code, per-currency, never blended/float.
-- Grain: one row per (brand_id, touchpoint_id, data_version); brand_id FIRST/tenant key; ${BRAND_PREDICATE}
-- seam at read (brand_id = ?). Consumers wanting the CURRENT journey filter is_current = true.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.semantic_journey AS
SELECT
  brand_id,
  brain_id,
  touchpoint_id,
  source_event_ref,
  data_version,
  is_current,
  sequence_number,
  occurred_at,
  session_key,
  event_category,
  event_type,
  channel,
  campaign,
  revenue_minor,
  currency_code,
  product_handles,
  attribution_signals,
  identity_confidence,
  brain_id_asof,
  identity_confidence_asof,
  is_composite,
  composite_order_key,
  matched_via,
  identity_basis,
  ingested_at,
  updated_at
FROM iceberg.brain_gold.journey_events;
