-- ============================================================
-- SPEC: A.3 (WA-20) / §1.4 — customer_sessions_extended_v: the ONLY sanctioned consumer surface for
-- probabilistic session→customer links. Segments / behavior read THIS view (never
-- iceberg.brain_silver.silver_probabilistic_stitch directly); attribution/revenue read NEITHER — they
-- read silver_touchpoint / silver_session_identity only (§1.4, enforced by
-- db/iceberg/spark/silver/probabilistic_quarantine_guard_test.py).
--
-- SHAPE: deterministic session identities UNION ALL probabilistic ones, each tagged with an
-- `identity_basis` discriminator ('deterministic' | 'probabilistic') so every consumer can tell the two
-- apart and the gateway can auto-add `estimated: true` whenever a probabilistic row contributes.
--
--   DETERMINISTIC leg — sessionized silver_touchpoint (AMD-13: silver_session_identity is a later Wave A
--   deliverable, WA-16; until it lands the deterministic identity is the touchpoint's stitched_brain_id).
--   Grain here: one row per (brand_id, session_id = brain_anon_id). confidence = 1.0 (deterministic).
--
--   PROBABILISTIC leg — brain_silver.silver_probabilistic_stitch (Splink ≥ 0.95, QUARANTINED). On golden
--   / a fresh stack this leg is EMPTY (the `identity.probabilistic` flag is OFF for every brand ⇒ 0 rows
--   written ⇒ the view degenerates to the deterministic leg, byte-identical, §0.5).
--
-- brand_id is the first/tenant key; ${BRAND_PREDICATE} injects brand_id = ? at read time. hash-only PII
-- (session_id = opaque anon; brain_id is a hashed/opaque id — no raw PII, serving-pii-guard clean).
-- ============================================================
CREATE OR REPLACE VIEW brain_serving.customer_sessions_extended_v AS
SELECT
  brand_id,
  session_id,
  brain_id,
  CAST(confidence AS double)     AS confidence,
  identity_basis,
  model_version,
  scored_at
FROM (
  -- deterministic: one identity per (brand_id, brain_anon_id) from stitched touchpoints
  SELECT
    brand_id,
    brain_anon_id                AS session_id,
    MAX(stitched_brain_id)       AS brain_id,
    1.0                          AS confidence,
    'deterministic'              AS identity_basis,
    CAST(NULL AS varchar)        AS model_version,
    MAX(occurred_at)             AS scored_at
  FROM iceberg.brain_silver.silver_touchpoint
  WHERE stitched_brain_id IS NOT NULL
  GROUP BY brand_id, brain_anon_id

  UNION ALL

  -- probabilistic: Splink ≥ 0.95 (QUARANTINED; EMPTY while identity.probabilistic is OFF)
  SELECT
    brand_id,
    session_id,
    probabilistic_brain_id       AS brain_id,
    confidence,
    'probabilistic'              AS identity_basis,
    model_version,
    scored_at
  FROM iceberg.brain_silver.silver_probabilistic_stitch
);
