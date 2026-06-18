-- ============================================================================
-- 0033_consent_record_tombstone.sql
-- feat-d13-consent-cancontact — Track A (@data-engineer). Architecture §2.
-- ============================================================================
--
-- THE consent system of record (DPDP 2023 lawful-basis) + the append-only
-- withdrawal/erasure tombstone that drives can_contact() fail-closed suppression.
--
-- Both tables are keyed on subject_hash = sha256(per-brand-salt ‖ normalized
--   email/phone) via @brain/identity-core (NEVER raw PII; I-S02). The chokepoint
--   resolves a recipient ADDRESS → hash, not a brain_id, so the SoR is addressable
--   from the send path. Same hash already stored as identity_link.identifier_value
--   → a brain_id↔subject_hash join is preserved for later.
--
-- FAIL-CLOSED (DPDP §13.4 / COMPLIANCE.md): the absence of a granted consent_record
--   OR the presence of a tombstone => SUPPRESSED. No "unknown => allow" path exists.
--
-- APPEND-ONLY by GRANT (mirrors realized_revenue_ledger 0018 / identity_audit 0017):
--   brain_app holds SELECT + INSERT only. NO UPDATE / NO DELETE grant — corrections
--   are a NEW row with a later effective_at (consent_record) or a new tombstone.
--   Asserted at migration tail (Assertion-2). Auditable consent state by construction.
--
-- RLS ENABLE + FORCE on both tables; NN-1 two-arg fail-closed policy verbatim from
--   0017 (missing GUC → current_setting(...,TRUE)=NULL → brand_id=NULL → FALSE → 0 rows).
--   Verified NON-INERT under brain_app (superuser 'brain' BYPASSES → proves nothing).
--
-- IDEMPOTENCY (replay-safe consumer): source_event_id dedup unique indexes →
--   the consent-suppressor writes ON CONFLICT DO NOTHING. 3× replay → same state.
--
-- ADDITIVE ONLY (I-E02): CREATE TABLE / INDEX IF NOT EXISTS only.
-- ROLLBACK (migrate down):
--   DROP TABLE IF EXISTS consent_tombstone;
--   DROP TABLE IF EXISTS consent_record;
-- ============================================================================

-- ── 1. consent_record — 4-category lawful-basis SoR (append-only) ─────────────
-- One row per consent state assertion. Latest-wins by effective_at within
-- (brand_id, subject_hash, category). source='consent_manager' is forward-compatible
-- with the DPDP Rules 2025 Consent Manager framework (~Nov 2026, COMPLIANCE.md §1).
CREATE TABLE IF NOT EXISTS consent_record (
  brand_id          UUID        NOT NULL,
  subject_hash      TEXT        NOT NULL,   -- sha256(per-brand-salt ‖ normalized); 64-hex; NEVER raw PII
  category          TEXT        NOT NULL
                      CHECK (category IN ('analytics','marketing','personalization','ai_processing')),
  state             TEXT        NOT NULL
                      CHECK (state IN ('granted','withdrawn')),
  source            TEXT        NOT NULL DEFAULT 'collector'
                      CHECK (source IN ('collector','operator','api','import','consent_manager')),
  policy_version    TEXT        NOT NULL DEFAULT 'v1',   -- which consent text was shown (lawful basis)
  effective_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_event_id   UUID        NULL,                    -- idempotency anchor (collector event_id)
  PRIMARY KEY (brand_id, subject_hash, category, effective_at)
);

-- Idempotency: a replayed collector event must not double-write. Partial unique on
-- source_event_id (only when present — operator/API writes may omit it and rely on
-- the PK's effective_at uniqueness).
CREATE UNIQUE INDEX IF NOT EXISTS consent_record_event_dedup
  ON consent_record (brand_id, subject_hash, category, source_event_id)
  WHERE source_event_id IS NOT NULL;

-- Latest-state lookup: the SuppressionQuery reads the newest row per category.
CREATE INDEX IF NOT EXISTS idx_consent_record_latest
  ON consent_record (brand_id, subject_hash, category, effective_at DESC);

ALTER TABLE consent_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_record FORCE ROW LEVEL SECURITY;

CREATE POLICY consent_record_isolation ON consent_record
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON consent_record FROM brain_app;
GRANT SELECT, INSERT ON consent_record TO brain_app;   -- append-only: no UPDATE/DELETE

-- ── 2. consent_tombstone — append-only withdrawal/erasure marker ──────────────
-- Written immediately on withdrawal/erasure. Drives fast-path suppression: a
-- tombstone existence (category-specific OR category IS NULL = all) => SUPPRESSED,
-- regardless of any later-effective consent_record state (withdrawal is sticky).
-- Surrogate PK (gen_random_uuid) avoids a COALESCE-on-NULL composite PK; uniqueness
-- of intent is enforced by the dedup index below.
CREATE TABLE IF NOT EXISTS consent_tombstone (
  tombstone_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id          UUID        NOT NULL,
  subject_hash      TEXT        NOT NULL,   -- hashed; NEVER raw PII
  category          TEXT        NULL        -- NULL = ALL categories withdrawn; else a specific one
                      CHECK (category IS NULL OR category IN ('analytics','marketing','personalization','ai_processing')),
  reason            TEXT        NOT NULL DEFAULT 'withdrawal'
                      CHECK (reason IN ('withdrawal','erasure')),
  source            TEXT        NOT NULL DEFAULT 'collector'
                      CHECK (source IN ('collector','operator','api','consent_manager')),
  tombstoned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_event_id   UUID        NULL,
  PRIMARY KEY (brand_id, tombstone_id)
);

-- Idempotency: a replayed withdrawal event must not double-write. category is part of
-- the key because ONE collector event can withdraw several categories (each a distinct
-- tombstone) — they must not collide on source_event_id. COALESCE(category,'*') keys the
-- NULL=all-categories tombstone distinctly from per-category ones.
CREATE UNIQUE INDEX IF NOT EXISTS consent_tombstone_event_dedup
  ON consent_tombstone (brand_id, subject_hash, COALESCE(category, '*'), source_event_id)
  WHERE source_event_id IS NOT NULL;

-- Fast-path existence read for the SuppressionQuery (<15min withdrawal SLA).
CREATE INDEX IF NOT EXISTS idx_consent_tombstone_subject
  ON consent_tombstone (brand_id, subject_hash);

ALTER TABLE consent_tombstone ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_tombstone FORCE ROW LEVEL SECURITY;

CREATE POLICY consent_tombstone_isolation ON consent_tombstone
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON consent_tombstone FROM brain_app;
GRANT SELECT, INSERT ON consent_tombstone TO brain_app;  -- append-only: no UPDATE/DELETE

-- ── 3. Migration-time assertions ──────────────────────────────────────────────

-- Assertion-1: NN-1 — all RLS policies use two-arg current_setting (copy 0017 DO-block).
-- Fails the migration on any one-arg form (which 500s on missing GUC instead of
-- fail-closing to 0 rows).
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE (
      (qual LIKE '%current_setting(''app.current_brand_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%')
      OR
      (qual LIKE '%current_setting(''app.current_user_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_user_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_user_id'', true)%')
      OR
      (qual LIKE '%current_setting(''app.current_workspace_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_workspace_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_workspace_id'', true)%')
      OR
      (qual LIKE '%current_setting(''app.role'')%'
       AND qual NOT LIKE '%current_setting(''app.role'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.role'', true)%')
    )
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting. '
      'Replace with two-arg form: current_setting(''guc_name'', TRUE).',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;

-- Assertion-2: Append-only-by-GRANT — brain_app must NOT hold UPDATE or DELETE on
-- either consent table (consent state is auditable + immutable; corrections are new rows).
DO $$
DECLARE
  bad_grant RECORD;
BEGIN
  FOR bad_grant IN
    SELECT table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_name   IN ('consent_record', 'consent_tombstone')
      AND grantee      = 'brain_app'
      AND privilege_type IN ('UPDATE', 'DELETE')
  LOOP
    RAISE EXCEPTION
      'APPEND-ONLY VIOLATION: brain_app holds "%" on %. '
      'Only SELECT and INSERT are permitted (consent state is immutable by construction).',
      bad_grant.privilege_type, bad_grant.table_name;
  END LOOP;
END
$$;

-- Assertion-3: RLS FORCE is enabled on both tables (a table with RLS enabled but not
-- FORCE leaks to the owner role; FORCE makes isolation hold even for the table owner).
DO $$
DECLARE
  bad_table RECORD;
BEGIN
  FOR bad_table IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('consent_record', 'consent_tombstone')
      AND (c.relrowsecurity = FALSE OR c.relforcerowsecurity = FALSE)
  LOOP
    RAISE EXCEPTION
      'RLS-FORCE VIOLATION: table "%" does not have ENABLE + FORCE ROW LEVEL SECURITY. '
      'Brand isolation would be inert.', bad_table.relname;
  END LOOP;
END
$$;
