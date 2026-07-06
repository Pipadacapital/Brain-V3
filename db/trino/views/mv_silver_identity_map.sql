-- ============================================================
-- Brain V4 — Trino serving VIEW: mv_silver_identity_map
--
-- Serving analogue of the Spark-materialized bitemporal identity map
-- (iceberg.brain_silver.silver_identity_map). A THIN projection only (no compute) — the
-- effective-interval history is already materialized by silver_identity_map.py from the Neo4j SoR.
--
-- Grain: one row per (brand_id, identifier_hash, brain_id, effective_from) — the interval during which
-- that hashed identifier resolved to that brain_id. WHERE is_current filters to the live mapping;
-- effective_from/effective_to enable AS-OF point-in-time resolution ("which brain_id on date D").
--
-- No money. identifier_hash is a 64-hex HASH only (hash-only PII rule). customer_ref is the public
-- BRN- surrogate (1:1 with brain_id). brand_id is the tenant key; ${BRAND_PREDICATE} injects brand_id = ?.
-- The metric-engine reads this as brain_serving.mv_silver_identity_map.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_silver_identity_map AS
SELECT
  brand_id,
  identifier_hash,
  identifier_type,
  brain_id,
  customer_ref,
  confidence,
  effective_from,
  effective_to,
  -- SPEC: A.1.5 — the SYSTEM-TIME axis (AMD-07). system_to IS NULL = the version the system currently
  -- knows; the pair (effective_*, system_*) makes this the raw bi-temporal serving projection. Governed
  -- as-of / current reads go through identity_asof / identity_current_v.
  system_from,
  system_to,
  replaced_by_brain_id,
  merge_event_id,
  is_current,
  updated_at
FROM iceberg.brain_silver.silver_identity_map;
