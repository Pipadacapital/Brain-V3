-- ============================================================
-- SPEC: A.2.2 / A.1.5 — SANCTIONED identity accessor (Trino): identity_current_v
--
-- The VALID-NOW + KNOWN-NOW view of the bi-temporal silver_identity_map (AMD-07): the single mapping a
-- hashed identifier resolves to RIGHT NOW. This is the operational accessor — every "who is this today"
-- serving/analytics path reads identity_current_v, NEVER iceberg.brain_silver.silver_identity_map directly
-- (enforced by tools/lint/identity-view-guard.sh). Its Spark mirror is _identity_views.identity_current().
--
-- Predicate = both temporal axes pinned to "now":
--   valid-time  : is_current = true      (the mapping is currently valid)
--   system-time : system_to  IS NULL     (this is the version the system currently knows / not superseded)
--
-- Grain: one row per (brand_id, identifier_hash) live mapping. identifier_hash is a 64-hex HASH only
-- (hash-only PII rule); no money. brand_id is the first/tenant key; ${BRAND_PREDICATE} injects brand_id = ?.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.identity_current_v AS
SELECT
  brand_id,
  identifier_type,
  identifier_hash,
  brain_id,
  confidence
FROM iceberg.brain_silver.silver_identity_map
WHERE is_current = true
  AND system_to IS NULL;
