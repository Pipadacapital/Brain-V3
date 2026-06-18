-- ============================================================================
-- 0033_send_log.sql
-- feat-d13-consent-cancontact — Track B (@backend-developer). Architecture §4.
-- ============================================================================
--
-- send_log — the OPERATIONAL record of outbound notification attempts AND the
-- can_contact() gate outcome, including the pending_window queue.
--
-- This is distinct from the append-only consent SoR (consent_record /
-- consent_tombstone, migration 0032): send_log is an OPERATIONAL log whose status
-- transitions (attempted → sent / failed; pending_window → released / blocked). It
-- therefore grants UPDATE to brain_app (the 09:00-IST flush handler transitions a
-- pending_window row to released/blocked). It is NOT a consent system of record and
-- carries NO lawful-basis state — only delivery + gate metadata.
--
-- PII (I-S02): the subject is identified by subject_hash ONLY (identity-core per-brand
-- salt hash). Raw email/phone is NEVER written to a column. The legacy transactional
-- senders log a masked recipient to stdout but persist nothing here without a hash.
--
-- STATUS values:
--   attempted      — a send was attempted (pre-provider).
--   sent           — provider accepted.
--   failed         — provider rejected / errored.
--   blocked        — can_contact() blocked the send (blocked_reason set).
--   pending_window — out-of-window; queued, release_after set; flushed at 09:00 IST.
--   released       — a pending_window row that re-passed the gate at flush time.
--
-- RLS ENABLE + FORCE; NN-1 two-arg fail-closed policy verbatim from 0017/0032
--   (missing GUC → current_setting(...,TRUE)=NULL → brand_id=NULL → FALSE → 0 rows).
--   Verified NON-INERT under brain_app (superuser 'brain' BYPASSES → proves nothing).
--
-- ADDITIVE ONLY (I-E02): CREATE TABLE / INDEX IF NOT EXISTS only.
-- ROLLBACK (migrate down):
--   DROP TABLE IF EXISTS send_log;
-- ============================================================================

CREATE TABLE IF NOT EXISTS send_log (
  id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id          UUID        NOT NULL,
  subject_hash      TEXT        NULL,        -- identity-core hash; NULL only for legacy/system rows. NEVER raw PII.
  channel           TEXT        NOT NULL,    -- transactional_email | marketing_email | whatsapp | sms | email (legacy)
  notification_type TEXT        NOT NULL,    -- e.g. email_verification | password_reset | invite | morning_brief
  status            TEXT        NOT NULL
                      CHECK (status IN ('attempted','sent','failed','blocked','pending_window','released')),
  blocked_reason    TEXT        NULL,        -- can_contact() reason when status='blocked' (e.g. consent_absent, dlt_unregistered)
  release_after     TIMESTAMPTZ NULL,        -- next 09:00 IST when status='pending_window'
  correlation_id    TEXT        NULL,        -- request correlation for tracing
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The 09:00-IST flush handler scans due pending_window rows by (brand, status, release_after).
CREATE INDEX IF NOT EXISTS idx_send_log_pending_window
  ON send_log (brand_id, status, release_after)
  WHERE status = 'pending_window';

-- Gate-activity / recent-send reads order by recency within a brand.
CREATE INDEX IF NOT EXISTS idx_send_log_brand_recent
  ON send_log (brand_id, created_at DESC);

ALTER TABLE send_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_log FORCE ROW LEVEL SECURITY;

CREATE POLICY send_log_isolation ON send_log
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON send_log FROM brain_app;
-- Operational log: SELECT + INSERT + UPDATE (status transitions). NO DELETE (audit trail).
GRANT SELECT, INSERT, UPDATE ON send_log TO brain_app;

-- ── Migration-time assertions ─────────────────────────────────────────────────

-- Assertion-1: NN-1 — the send_log policy uses two-arg current_setting (fail-closed).
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT policyname, qual
    FROM pg_policies
    WHERE tablename = 'send_log'
      AND qual LIKE '%current_setting(''app.current_brand_id'')%'
      AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
      AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%'
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on send_log uses one-arg current_setting. '
      'Replace with two-arg form: current_setting(''app.current_brand_id'', TRUE).',
      bad_policy.policyname;
  END LOOP;
END
$$;

-- Assertion-2: RLS FORCE is enabled (a table with RLS enabled but not FORCE leaks to
-- the owner role; FORCE makes isolation hold even for the table owner).
DO $$
DECLARE
  bad_table RECORD;
BEGIN
  FOR bad_table IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'send_log'
      AND (c.relrowsecurity = FALSE OR c.relforcerowsecurity = FALSE)
  LOOP
    RAISE EXCEPTION
      'RLS-FORCE VIOLATION: table "%" does not have ENABLE + FORCE ROW LEVEL SECURITY. '
      'Brand isolation would be inert.', bad_table.relname;
  END LOOP;
END
$$;

-- Assertion-3: brain_app must NOT hold DELETE on send_log (delivery audit trail is
-- never destroyed; status transitions are UPDATEs, not deletes).
DO $$
DECLARE
  bad_grant RECORD;
BEGIN
  FOR bad_grant IN
    SELECT privilege_type
    FROM information_schema.role_table_grants
    WHERE table_name = 'send_log'
      AND grantee    = 'brain_app'
      AND privilege_type = 'DELETE'
  LOOP
    RAISE EXCEPTION
      'SEND-LOG VIOLATION: brain_app holds DELETE on send_log. '
      'The delivery audit trail must not be deletable.';
  END LOOP;
END
$$;
