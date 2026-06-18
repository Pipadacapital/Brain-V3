-- ============================================================================
-- 0034_capi_passback_log.sql
-- feat-capi-conversion-feedback — Track A (@data-engineer). Architecture §4.
-- ============================================================================
--
-- Phase 6 — Conversion Feedback. The append-only record of every Meta CAPI
-- conversion-passback DECISION + every retroactive deletion request, plus the
-- additive widening of the consent category vocabulary with the 5th DPDP
-- lawful-basis category 'advertising' (distinct from 'marketing' — purpose
-- limitation: a subject may consent to marketing email but NOT to having their
-- conversion hashed-and-sent to an ad platform).
--
-- THE INVARIANTS THIS MIGRATION ENCODES:
--   • I-ST05 / non_consented_sends=0: capi_passback_log is the AUDIT of the gate.
--     A blocked event is recorded with status='blocked_no_consent' (NOT silently
--     dropped); a dev send is 'would_send_dev' (NEVER 'sent' without real creds).
--   • PII minimization (COMPLIANCE.md §Controls): NO raw email/phone column.
--     subject_hash = sha256(per-brand-salt ‖ normalized) — the SAME internal hash
--     as consent_record/identity_link, 64-hex, NEVER raw PII. The Meta-format
--     unsalted match keys (em/ph) are computed transiently at the send boundary
--     and put ONLY on the wire — they are NEVER persisted here.
--   • Money (I-S07): value_minor BIGINT minor + currency_code CHAR(3). No float.
--   • Append-only by GRANT (mirrors 0018 / 0033): brain_app holds SELECT+INSERT
--     only. NO UPDATE / NO DELETE. Corrections are a NEW row. Asserted (Assertion-2).
--   • RLS ENABLE + FORCE on both logs; NN-1 two-arg fail-closed policy verbatim
--     from 0033 (missing GUC → current_setting(...,TRUE)=NULL → brand_id=NULL →
--     FALSE → 0 rows). Verified NON-INERT under brain_app (superuser 'brain'
--     BYPASSES → proves nothing).
--   • Idempotency (replay-safe): the deterministic Meta event_id (PK backstop) +
--     the deletion source_event_id dedup index → ON CONFLICT DO NOTHING. 3× replay
--     → same state.
--
-- ADDITIVE ONLY (I-E02): CREATE TABLE/INDEX IF NOT EXISTS + an additive CHECK
--   widening (DROP CONSTRAINT IF EXISTS → ADD widened CHECK; widening a CHECK never
--   invalidates an existing row).
-- ROLLBACK (migrate down):
--   DROP TABLE IF EXISTS capi_deletion_log;
--   DROP TABLE IF EXISTS capi_passback_log;
--   -- revert the consent-category CHECKs to the 4-category form (0033).
-- ============================================================================

-- ── 0. Consent-category vocabulary widening (additive) ───────────────────────
-- Add the 5th DPDP lawful-basis category 'advertising' to the ONE consent model.
-- Widening a CHECK is additive (FULL_TRANSITIVE-safe): every existing row already
-- satisfies the wider predicate. DROP IF EXISTS keeps the migration re-runnable.
ALTER TABLE consent_record DROP CONSTRAINT IF EXISTS consent_record_category_check;
ALTER TABLE consent_record
  ADD CONSTRAINT consent_record_category_check
  CHECK (category IN ('analytics','marketing','personalization','ai_processing','advertising'));

ALTER TABLE consent_tombstone DROP CONSTRAINT IF EXISTS consent_tombstone_category_check;
ALTER TABLE consent_tombstone
  ADD CONSTRAINT consent_tombstone_category_check
  CHECK (category IS NULL OR category IN ('analytics','marketing','personalization','ai_processing','advertising'));

-- ── 1. capi_passback_log — append-only record of every passback DECISION ──────
-- One row per (brand_id, event_id) — event_id is the DETERMINISTIC Meta dedup key
--   sha256(brand_id ‖ order_id ‖ 'Purchase' ‖ ledger_event_id). A replay produces
--   the SAME event_id → ON CONFLICT DO NOTHING → exactly one log row → Meta dedups.
-- status records the gate outcome:
--   'sent'               — prod: a real Meta CAPI POST succeeded (fbtrace_id set).
--   'blocked_no_consent' — the gate BLOCKED (no/withdrawn advertising consent). The
--                          adapter was UNREACHABLE — this is the non_consented_sends=0
--                          audit row (visible in the UI; the SLO made observable).
--   'would_send_dev'     — gate allowed but no real Meta creds (dev/default-closed
--                          stub) → NOTHING was sent. NEVER faked as 'sent'.
--   'deleted'            — superseded by a retroactive deletion (see capi_deletion_log).
--   'failed'             — prod send attempted and the Meta API returned an error.
CREATE TABLE IF NOT EXISTS capi_passback_log (
  brand_id          UUID        NOT NULL,                  -- tenant key / RLS anchor (I-S01)
  event_id          TEXT        NOT NULL,                  -- sha256(brand‖order‖'Purchase'‖ledger_event_id); Meta dedup key
  platform          TEXT        NOT NULL DEFAULT 'meta'
                      CHECK (platform IN ('meta')),
  order_id          TEXT        NOT NULL,
  subject_hash      TEXT        NOT NULL,                  -- internal salted 64-hex; the consent key; NEVER raw PII
  ledger_event_id   TEXT        NOT NULL,                  -- provenance into realized_revenue_ledger
  status            TEXT        NOT NULL
                      CHECK (status IN ('sent','blocked_no_consent','would_send_dev','deleted','failed')),
  block_reason      TEXT        NULL,                      -- can_contact() reason when status='blocked_no_consent'
  match_key_count   SMALLINT    NOT NULL DEFAULT 0         -- em+ph+fbc+fbp present count (match-quality proxy for the UI)
                      CHECK (match_key_count BETWEEN 0 AND 4),
  value_minor       BIGINT      NOT NULL,                  -- BIGINT minor units (I-S07); from realized_revenue_ledger
  currency_code     CHAR(3)     NOT NULL,                  -- paired with value_minor ALWAYS
  fbtrace_id        TEXT        NULL,                      -- Meta response id (prod 'sent' only)
  correlation_id    TEXT        NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,                  -- order occurred_at (the Meta event_time)
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, event_id)                         -- tenant-first; deterministic-id idempotency backstop
);

-- UI read index: recent rows per brand by status (summary counts + events table).
CREATE INDEX IF NOT EXISTS idx_capi_passback_status
  ON capi_passback_log (brand_id, status, recorded_at DESC);

-- Subject lookup: the deletion path resolves a withdrawn subject's prior passbacks.
CREATE INDEX IF NOT EXISTS idx_capi_passback_subject
  ON capi_passback_log (brand_id, subject_hash);

ALTER TABLE capi_passback_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE capi_passback_log FORCE ROW LEVEL SECURITY;

CREATE POLICY capi_passback_log_isolation ON capi_passback_log
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON capi_passback_log FROM brain_app;
GRANT SELECT, INSERT ON capi_passback_log TO brain_app;   -- append-only: no UPDATE/DELETE

-- ── 2. capi_deletion_log — append-only retroactive-deletion request record ────
-- Written by the CapiDeletionConsumer on an 'advertising' (or all-category)
-- consent withdrawal/tombstone, within the ≤15min DPDP withdrawal-propagation SLA.
-- Surrogate PK (gen_random_uuid) avoids a COALESCE-on-NULL composite PK; uniqueness
-- of intent is enforced by the dedup index below (mirrors consent_tombstone 0033).
-- status:
--   'requested'         — the deletion has been enqueued/recorded (the ≤15min anchor).
--   'deleted'           — prod: a Meta CAPI deletion/suppression POST succeeded.
--   'would_delete_dev'  — dev/default-closed stub: NOTHING was sent to Meta.
--   'failed'            — prod deletion attempted and Meta returned an error.
CREATE TABLE IF NOT EXISTS capi_deletion_log (
  deletion_id       UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id          UUID        NOT NULL,                  -- tenant key / RLS anchor (I-S01)
  subject_hash      TEXT        NOT NULL,                  -- the withdrawn subject (internal salted 64-hex); NEVER raw PII
  platform          TEXT        NOT NULL DEFAULT 'meta'
                      CHECK (platform IN ('meta')),
  source_event_id   UUID        NULL,                      -- the withdrawal/tombstone collector event_id (idempotency anchor)
  status            TEXT        NOT NULL
                      CHECK (status IN ('requested','deleted','would_delete_dev','failed')),
  event_count       INT         NOT NULL DEFAULT 0,        -- how many prior passback events were targeted for deletion
  tombstoned_at     TIMESTAMPTZ NULL,                      -- the withdrawal time (for the ≤15min latency measurement)
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ NULL,
  PRIMARY KEY (brand_id, deletion_id)
);

-- Idempotency: a replayed withdrawal event must not double-request a deletion.
-- Keyed on the withdrawal source_event_id (only when present); a replay is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS capi_deletion_log_event_dedup
  ON capi_deletion_log (brand_id, subject_hash, platform, source_event_id)
  WHERE source_event_id IS NOT NULL;

-- UI read index: recent deletion requests per brand.
CREATE INDEX IF NOT EXISTS idx_capi_deletion_recent
  ON capi_deletion_log (brand_id, requested_at DESC);

ALTER TABLE capi_deletion_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE capi_deletion_log FORCE ROW LEVEL SECURITY;

CREATE POLICY capi_deletion_log_isolation ON capi_deletion_log
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON capi_deletion_log FROM brain_app;
GRANT SELECT, INSERT ON capi_deletion_log TO brain_app;   -- append-only: no UPDATE/DELETE

-- ── 3. Migration-time assertions (copied verbatim discipline from 0033) ───────

-- Assertion-1: NN-1 — all RLS policies use two-arg current_setting (fail-closed on
-- a missing GUC instead of 500-ing). Scans pg_policies for any one-arg form.
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
-- either CAPI log (the passback decision + deletion record are immutable audit).
DO $$
DECLARE
  bad_grant RECORD;
BEGIN
  FOR bad_grant IN
    SELECT table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_name   IN ('capi_passback_log', 'capi_deletion_log')
      AND grantee      = 'brain_app'
      AND privilege_type IN ('UPDATE', 'DELETE')
  LOOP
    RAISE EXCEPTION
      'APPEND-ONLY VIOLATION: brain_app holds "%" on %. '
      'Only SELECT and INSERT are permitted (CAPI audit is immutable by construction).',
      bad_grant.privilege_type, bad_grant.table_name;
  END LOOP;
END
$$;

-- Assertion-3: RLS FORCE is enabled on both logs (RLS enabled but not FORCE leaks
-- to the owner role; FORCE makes isolation hold even for the table owner).
DO $$
DECLARE
  bad_table RECORD;
BEGIN
  FOR bad_table IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('capi_passback_log', 'capi_deletion_log')
      AND (c.relrowsecurity = FALSE OR c.relforcerowsecurity = FALSE)
  LOOP
    RAISE EXCEPTION
      'RLS-FORCE VIOLATION: table "%" does not have ENABLE + FORCE ROW LEVEL SECURITY. '
      'Brand isolation would be inert.', bad_table.relname;
  END LOOP;
END
$$;

-- Assertion-4: No raw-PII column — defense-in-depth lint against a column whose name
-- implies plaintext contact data ever landing in a CAPI log. Only hashed/derived keys
-- (subject_hash) and the wire-format match keys (NEVER persisted) are permitted.
DO $$
DECLARE
  bad_col RECORD;
BEGIN
  FOR bad_col IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('capi_passback_log', 'capi_deletion_log')
      AND (
        column_name IN ('email','phone','phone_number','full_name','name')
        OR column_name LIKE 'raw_%'
        OR column_name LIKE '%_email'
        OR column_name LIKE '%_phone'
      )
  LOOP
    RAISE EXCEPTION
      'RAW-PII VIOLATION: column %.% looks like plaintext PII. '
      'CAPI logs store only subject_hash (salted 64-hex); raw email/phone NEVER persisted.',
      bad_col.table_name, bad_col.column_name;
  END LOOP;
END
$$;
