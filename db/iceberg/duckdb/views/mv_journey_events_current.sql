-- ============================================================
-- Brain V4 — DuckDB serving VIEW: mv_journey_events_current
--
-- Brain V4 serving runs over DUCKDB (Iceberg). This view is the thin serving projection over the
-- versioned event-sourced journey ledger Spark builds (iceberg.brain_gold.journey_events —
-- gold_journey_events.py + its merge re-versioning companion gold_journey_events_reversion.py,
-- spec gap G4 re-ratified). WHERE is_current = true keeps exactly ONE live version per touchpoint:
-- an identity merge flips the superseded version's flag and appends a data_version+1 copy owned by
-- the canonical brain_id — history is never rewritten, and this view always shows the canonical
-- resolved timeline. Serving is fast because Gold is already materialized by Spark; the view is a
-- filtered column projection only (no compute). Redis fronts hot reads.
--
-- Grain (served): one row per (brand_id, touchpoint_id) — the current version of each journey
-- event. sequence_number orders the resolved-identity timeline (brand_id, brain_id).
--
-- MONEY: revenue_minor is bigint MINOR units with the sibling currency_code — never a float, never
-- blended; it is non-NULL ONLY on composite transaction rows (revenue truth is the connector order,
-- joined from silver_order_state at build time).
--
-- The metric-engine reads this as the two-part name brain_serving.mv_journey_events_current; in
-- duckdb-serving that resolves to this LOCAL view (the Iceberg REST catalog is
-- attached as `iceberg`; local views shadow its namespace). brand_id is the tenant
-- key; the ${BRAND_PREDICATE} seam injects brand_id = ? at read time.
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.mv_journey_events_current AS
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
  -- DG-2 POINT-IN-TIME (AS-OF) identity: the brain_id/confidence that owned the identity AT
  -- occurred_at (bi-temporal silver_identity_map interval covering the event). NULL = the event
  -- predates the identity, or the row is anonymous_/unmapped (honest as-of resolution).
  brain_id_asof,
  identity_confidence_asof,
  is_composite,
  composite_order_key,
  ingested_at,
  updated_at,
  -- SPEC: B.1 — identity-link provenance for the resolved brain_id (matched_via[]) + identity_basis
  -- ('deterministic' — the canonical ledger is deterministic-only per §1.4; probabilistic overlays
  -- live in a separate view). The B.3 journey APIs surface matched_via per touchpoint.
  matched_via,
  identity_basis
FROM iceberg.brain_gold.journey_events
WHERE is_current = true;
