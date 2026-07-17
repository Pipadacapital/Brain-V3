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
--
-- DUCKDB 1.5.4 + iceberg BUG MITIGATION (2026-07-17): on MERGE-heavy Iceberg tables whose accumulated
-- delete-file row counts exceed the estimated record count (here: silver_probabilistic_stitch, 0 live
-- rows after restatements), the iceberg scan's cardinality estimate (records − deletes) WRAPS NEGATIVE
-- as unsigned (seen live: 2^64−230550) and StatisticsPropagator::PropagateUnion then dies adding the
-- two legs' cardinalities: `INTERNAL Error: Information loss on integer cast: value 18446744073709378973`
-- (= 2^64−230550 + 57907 touchpoint rows). Each UNION leg is therefore wrapped in a subquery with
-- LIMIT 1000000000000 (10^12 — 7 orders of magnitude above this tier's data volumes, so row-for-row
-- identical output): a LIMIT node CLAMPS the leg's cardinality estimate to min(limit, child), so the
-- wrapped estimate can never reach PropagateUnion. Belt-and-braces with the connection-level
-- `SET disabled_optimizers='statistics_propagation'` in db/iceberg/duckdb/_catalog.py; remove both
-- once duckdb/duckdb-iceberg fixes the unsigned cardinality underflow.
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
  SELECT * FROM (
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
    LIMIT 1000000000000 -- cardinality-estimate clamp ONLY (see header); never binds at this tier's volumes
  )

  UNION ALL

  -- probabilistic: Splink ≥ 0.95 (QUARANTINED; EMPTY while identity.probabilistic is OFF)
  SELECT * FROM (
    SELECT
      brand_id,
      session_id,
      probabilistic_brain_id       AS brain_id,
      confidence,
      'probabilistic'              AS identity_basis,
      model_version,
      scored_at
    FROM iceberg.brain_silver.silver_probabilistic_stitch
    LIMIT 1000000000000 -- cardinality-estimate clamp ONLY (see header); never binds at this tier's volumes
  )
);
