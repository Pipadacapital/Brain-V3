-- SPEC: A.2.3 (WA-16, deterministic multi-key stitch — the conflict → merge-review bridge)
-- ============================================================================
-- 0123_stitch_conflict_review.sql — ops.stitch_conflict_review: the lightweight PG bridge that turns
--   a stitch-v2 AMBIGUITY (|B|>1) with SHARED EMAIL/PHONE evidence into a pending merge-review row.
-- ============================================================================
-- WHAT: silver_session_identity's Spark job (db/iceberg/spark/silver/silver_session_identity.py) resolves
--   each unstitched session's identifier set through identity_current_v. When the set resolves to MORE
--   THAN ONE brain_id it NEVER guesses — it writes a row to brain_silver.silver_stitch_conflicts (the
--   Iceberg SoR for every conflict). A SUBSET of those conflicts is genuinely MERGE-eligible: the ones
--   whose ambiguity comes from a SHARED EMAIL or PHONE hash resolving to two brain_ids (A.2.4 merges on
--   deterministic email/phone evidence). THOSE — and ONLY those — are enqueued here as pending reviews.
--
-- WHY only email/phone-evidenced conflicts (the "never wrongly merge" guard): a SHARED-DEVICE conflict
--   (one anonymous_id, two family members with DIFFERENT emails) is NOT a merge candidate — merging the
--   two people would be wrong. That conflict still lands in silver_stitch_conflicts (audit), but it is
--   NOT enqueued here. The bridge only surfaces conflicts backed by a strong shared identifier, matching
--   the merge-review queue's original contract (0017 §7: phone-guard + cycle-guard conflicts).
--
-- WHY a NEW ops table (not the old public.merge_review_queue): that table was DROPPED in the medallion
--   realignment (0101 dropped identity.merge_review_queue; identity SoR moved to Neo4j, review surfacing
--   moved to graph ops — apps/core/.../merge-admin.ts). This is application/operational state written by
--   a batch job → PostgreSQL `ops` schema (the 0116/0120/0122 precedent), NOT Iceberg (the FACT SoR is
--   silver_stitch_conflicts). Additive, flag-gated: rows appear ONLY when `stitch.v2` is ON for a brand.
--
-- SHAPE mirrors the original merge_review_queue (0017 §7): {brand_id, review_id, brain_id_a, brain_id_b,
--   trigger_reason, evidence(hashed JSONB), status}. review_id is a DETERMINISTIC uuid (the job derives
--   uuid5(brand_id||session_id||brain_a||brain_b)) so a re-run is idempotent (ON CONFLICT DO NOTHING).
--   evidence carries HASHED identifiers only (64-hex) — NEVER raw PII (0017 §7 posture).
--
-- RLS: FORCE + brand_id isolation on app.current_brand_id (mirror ops.brand_identity_priority / 0122);
--   the Spark JDBC writer SETs app.current_brand_id per brand before inserting (batch runs per-brand).
--   INSERT + SELECT for brain_app (append-only queue; status transitions are a follow-up admin surface).
--
-- node-pg-migrate runs with session search_path = public only → every object is schema-qualified.
-- ADDITIVE. Rollback: DROP TABLE ops.stitch_conflict_review (a derived operational queue, not a SoR).
-- ============================================================================

-- Up Migration

CREATE SCHEMA IF NOT EXISTS ops;
GRANT USAGE ON SCHEMA ops TO brain_app;

-- ── ops.stitch_conflict_review — merge-review rows derived from email/phone-evidenced stitch conflicts ──
CREATE TABLE IF NOT EXISTS ops.stitch_conflict_review (
  brand_id       UUID        NOT NULL,                                 -- tenant key / RLS anchor (I-S01)
  review_id      UUID        NOT NULL,                                 -- DETERMINISTIC (uuid5) → idempotent
  session_id     TEXT        NOT NULL,                                 -- the ambiguous session (anon:session_key)
  brain_id_a     UUID        NOT NULL,                                 -- the two candidate survivors (sorted)
  brain_id_b     UUID        NOT NULL,
  trigger_reason TEXT        NOT NULL DEFAULT 'stitch_conflict',       -- provenance of the queue row
  evidence       JSONB       NOT NULL DEFAULT '{}',                    -- HASHED identifiers only, no raw PII
  status         TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','merged','rejected','expired')),
  detected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, review_id),
  CONSTRAINT stitch_conflict_review_distinct_brains CHECK (brain_id_a <> brain_id_b),
  CONSTRAINT stitch_conflict_review_evidence_is_object CHECK (jsonb_typeof(evidence) = 'object')
);

-- Operator worklist read: pending rows per brand, newest first.
CREATE INDEX IF NOT EXISTS stitch_conflict_review_pending_idx
  ON ops.stitch_conflict_review (brand_id, status, detected_at DESC);

-- ── Tenant isolation — Postgres RLS (mirror ops.brand_identity_priority / 0122) ───
ALTER TABLE ops.stitch_conflict_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.stitch_conflict_review FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stitch_conflict_review_isolation ON ops.stitch_conflict_review;
CREATE POLICY stitch_conflict_review_isolation ON ops.stitch_conflict_review
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)        -- NN-1 two-arg fail-closed
  WITH CHECK (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);  -- writes pinned to session brand

-- brain_app grants: SELECT + INSERT (append-only queue; admin status flips are a follow-up surface).
REVOKE ALL ON ops.stitch_conflict_review FROM brain_app;
GRANT SELECT, INSERT ON ops.stitch_conflict_review TO brain_app;

-- ── Post-condition guard: born-secure (RLS enabled + forced) ──────────────────
DO $$
DECLARE
  rls_enabled BOOLEAN;
  rls_forced  BOOLEAN;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity
  INTO rls_enabled, rls_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'ops' AND c.relname = 'stitch_conflict_review';

  IF rls_enabled IS DISTINCT FROM TRUE OR rls_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      '0123 GUARD: ops.stitch_conflict_review must be RLS ENABLED + FORCED (enabled=%, forced=%).',
      rls_enabled, rls_forced;
  END IF;
END
$$;

-- Down Migration

DROP TABLE IF EXISTS ops.stitch_conflict_review;   -- reversible: a derived operational queue, NOT a SoR
