-- ============================================================
-- SPEC: A.2.2 / A.1.5 — SANCTIONED identity accessor (Trino): identity_asof
--
-- The BI-TEMPORAL point-in-time / replay view of silver_identity_map (AMD-07). Trino here has no polymorphic
-- table function, so identity_asof is a documented VIEW that EXPOSES ALL FOUR temporal columns
-- (effective_from, effective_to on the valid-time axis; system_from, system_to on the system-time axis) and
-- the caller applies the as-of predicate below. This is a sanctioned accessor — replay/audit paths read
-- identity_asof, NEVER iceberg.brain_silver.silver_identity_map directly (tools/lint/identity-view-guard.sh).
-- Its Spark mirror is _identity_views.identity_asof(spark, t_valid, t_system).
--
-- ┌─ AS-OF(T_valid, T_system) predicate — copy verbatim into a WHERE over this view ────────────────────┐
-- │   WHERE effective_from <= T_valid  AND (effective_to IS NULL OR effective_to > T_valid)             │
-- │     AND system_from   <= T_system AND (system_to   IS NULL OR system_to   > T_system)               │
-- │   -- current-only shortcut (= identity_current_v):  is_current = true AND system_to IS NULL          │
-- └────────────────────────────────────────────────────────────────────────────────────────────────────┘
-- Reconstructed from RETAINED interval rows (AMD-07 / AMD-10) — NOT Iceberg time-travel (the 7-day snapshot
-- TTL makes time-travel unusable as the system axis). Emitting the full interval set (current + superseded)
-- lets a consumer run its own interval-covering join (the DG-2 point-in-time pattern).
--
-- identifier_hash is a 64-hex HASH only (hash-only PII rule); no money. brand_id is the first/tenant key;
-- ${BRAND_PREDICATE} injects brand_id = ?.
-- ============================================================
CREATE OR REPLACE VIEW iceberg.brain_serving.identity_asof AS
SELECT
  brand_id,
  identifier_type,
  identifier_hash,
  brain_id,
  customer_ref,
  confidence,
  effective_from,
  effective_to,
  system_from,
  system_to,
  replaced_by_brain_id,
  merge_event_id,
  is_current
FROM iceberg.brain_silver.silver_identity_map;
