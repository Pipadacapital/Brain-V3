-- ============================================================================
-- 0002_auth.sql — Auth tables: app_user, user_session, password_reset, email_verification
-- ============================================================================
-- Doc refs: 03-architecture-plan.md §4 Migration 001 / NN-1 / NN-5 / I-S09
--
-- NOTE on app_user: NO RLS on app_user (cross-tenant login identity by design).
--   Isolation is enforced at the service layer (explicit WHERE app_user.id = $userId).
--   This is an explicit architectural choice (NN-1 table map), not an omission.
--
-- NOTE on password_hash: stores argon2id encoded string (not a secret token).
--   Semgrep allowlist: the column name 'password_hash' is the argon2 digest,
--   not a raw secret. It is exempt from the *_token/*_secret column rule (I-S09).
--
-- SECURITY: No column named *_token, *_secret, or *_key in this migration (I-S09).
--   Token values are always stored as sha256 hashes in *_hash columns.
-- ============================================================================

-- Enable citext extension for case-insensitive email uniqueness.
CREATE EXTENSION IF NOT EXISTS citext;

-- ── app_user — user-global login identity (NO RLS — service-layer isolation) ──
CREATE TABLE IF NOT EXISTS app_user (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  email               CITEXT      NOT NULL,
  email_normalized    TEXT        NOT NULL,
  password_hash       TEXT        NOT NULL,
  email_verified_at   TIMESTAMPTZ NULL,
  status              TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  CONSTRAINT app_user_email_unique UNIQUE (email)
);

-- Index on normalized email for lookups (case-insensitive search).
CREATE INDEX IF NOT EXISTS app_user_email_normalized_idx
  ON app_user (email_normalized);

-- Intentionally NO RLS on app_user — cross-tenant by nature.
-- Isolation via explicit WHERE clause at service layer.
ALTER TABLE app_user DISABLE ROW LEVEL SECURITY;

-- App role: SELECT, INSERT, UPDATE only. No DELETE (account permanence).
REVOKE ALL ON app_user FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON app_user TO brain_app;

-- ── user_session — access/refresh + revocation denylist (RLS: app.current_user_id) ──
-- jti = JWT id; the denylist key — set revoked_at to revoke the session (NN-3).
-- refresh_token_hash = sha256 of the rotating refresh secret (never plaintext — I-S09).
CREATE TABLE IF NOT EXISTS user_session (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  app_user_id         UUID        NOT NULL REFERENCES app_user(id),
  jti                 UUID        NOT NULL,
  refresh_token_hash  TEXT        NOT NULL,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ NULL,
  ip                  INET        NULL,
  user_agent          TEXT        NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  CONSTRAINT user_session_jti_unique UNIQUE (jti)
);

CREATE INDEX IF NOT EXISTS user_session_app_user_id_idx
  ON user_session (app_user_id);

CREATE INDEX IF NOT EXISTS user_session_jti_idx
  ON user_session (jti);

-- Partial index for active sessions (no revocation) — fast for session validation.
CREATE INDEX IF NOT EXISTS user_session_active_idx
  ON user_session (app_user_id)
  WHERE revoked_at IS NULL;

-- RLS: user sees only their own sessions (self-read only).
ALTER TABLE user_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_session FORCE ROW LEVEL SECURITY;

-- NN-1 two-arg fail-closed form: missing GUC → NULL → predicate false → 0 rows.
CREATE POLICY user_session_isolation ON user_session
  AS PERMISSIVE FOR ALL TO brain_app
  USING (app_user_id = current_setting('app.current_user_id', TRUE)::uuid);

REVOKE ALL ON user_session FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON user_session TO brain_app;

-- ── password_reset — single-use reset token (hashed) (RLS: app.current_user_id) ──
-- token_hash = sha256(crypto.randomBytes(32)) — never stored plaintext (NN-5 / I-S09).
-- expires_at = issued_at + 1h (NN-5).
-- used_at: set on use to prevent replay (NN-5 single-use).
CREATE TABLE IF NOT EXISTS password_reset (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  app_user_id     UUID        NOT NULL REFERENCES app_user(id),
  token_hash      TEXT        NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  CONSTRAINT password_reset_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS password_reset_token_hash_idx
  ON password_reset (token_hash);

CREATE INDEX IF NOT EXISTS password_reset_app_user_id_idx
  ON password_reset (app_user_id);

-- RLS: user sees only their own reset requests.
ALTER TABLE password_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset FORCE ROW LEVEL SECURITY;

CREATE POLICY password_reset_isolation ON password_reset
  AS PERMISSIVE FOR ALL TO brain_app
  USING (app_user_id = current_setting('app.current_user_id', TRUE)::uuid);

REVOKE ALL ON password_reset FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON password_reset TO brain_app;

-- ── email_verification — single-use email verification token (RLS: app.current_user_id) ──
-- token_hash = sha256(crypto.randomBytes(32)) — never stored plaintext (NN-5 / I-S09).
-- expires_at = issued_at + 24h (NN-5).
-- used_at: set on use to prevent replay (NN-5 single-use).
CREATE TABLE IF NOT EXISTS email_verification (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  app_user_id     UUID        NOT NULL REFERENCES app_user(id),
  token_hash      TEXT        NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  CONSTRAINT email_verification_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS email_verification_token_hash_idx
  ON email_verification (token_hash);

CREATE INDEX IF NOT EXISTS email_verification_app_user_id_idx
  ON email_verification (app_user_id);

-- RLS: user sees only their own verifications.
ALTER TABLE email_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verification FORCE ROW LEVEL SECURITY;

CREATE POLICY email_verification_isolation ON email_verification
  AS PERMISSIVE FOR ALL TO brain_app
  USING (app_user_id = current_setting('app.current_user_id', TRUE)::uuid);

REVOKE ALL ON email_verification FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON email_verification TO brain_app;

-- ── NN-1 assertion: extended to app.current_user_id one-arg form check ───────
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
    )
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting (missing_ok=false). '
      'All three GUCs must use two-arg form: current_setting(''guc_name'', TRUE)::uuid.',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;
