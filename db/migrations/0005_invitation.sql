-- ============================================================================
-- 0005_invitation.sql — Invitation table with compound RLS (NN-7)
-- ============================================================================
-- Doc refs: 03-architecture-plan.md §4 Migration 004 / NN-7 / NN-5 / I-S09
--
-- Product term "Invitation" → database table "invite" (D0.3).
--
-- CRITICAL NN-7: brand_id is NULLABLE (org-level vs brand-level invites).
-- A single RLS policy on brand_id alone would make workspace-level invites
-- (brand_id IS NULL) invisible (NULL = uuid is always false).
-- Solution: TWO PERMISSIVE policies (Postgres OR-combines PERMISSIVE policies):
--   Policy 1: org-level invites (brand_id IS NULL) — scoped by workspace_id.
--   Policy 2: brand-level invites (brand_id IS NOT NULL) — scoped by brand_id.
--
-- token_hash = sha256(crypto.randomBytes(32)) — never stored plaintext (NN-5 / I-S09).
-- expires_at = issued_at + 7 days (NN-5 invite token expiry).
-- ============================================================================

-- ── invite — invitation with nullable brand_id (compound RLS — NN-7) ─────────
-- SECURITY: No column named *_token or *_secret. token_hash stores sha256 only (I-S09).
CREATE TABLE IF NOT EXISTS invite (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  organization_id     UUID        NOT NULL REFERENCES organization(id),
  brand_id            UUID        NULL REFERENCES brand(id),
  email               CITEXT      NOT NULL,
  role_code           TEXT        NOT NULL
                        CHECK (role_code IN ('owner', 'brand_admin', 'manager', 'analyst')),
  token_hash          TEXT        NOT NULL,
  invited_by_user_id  UUID        NOT NULL REFERENCES app_user(id),
  status              TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at          TIMESTAMPTZ NOT NULL,
  accepted_at         TIMESTAMPTZ NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  CONSTRAINT invite_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS invite_token_hash_idx ON invite (token_hash);
CREATE INDEX IF NOT EXISTS invite_organization_id_idx ON invite (organization_id);
CREATE INDEX IF NOT EXISTS invite_brand_id_idx ON invite (brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invite_email_org_idx ON invite (email, organization_id);

-- ── RLS: COMPOUND TWO-POLICY approach (NN-7) ─────────────────────────────────
-- Postgres PERMISSIVE policies are OR-combined: a row is visible if ANY policy allows it.

ALTER TABLE invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite FORCE ROW LEVEL SECURITY;

-- Policy 1: Org-level invites (brand_id IS NULL) scoped by workspace_id.
CREATE POLICY invite_org_level ON invite
  AS PERMISSIVE FOR ALL TO brain_app
  USING (
    brand_id IS NULL
    AND organization_id = current_setting('app.current_workspace_id', TRUE)::uuid
  );

-- Policy 2: Brand-level invites (brand_id IS NOT NULL) scoped by brand_id.
CREATE POLICY invite_brand_level ON invite
  AS PERMISSIVE FOR ALL TO brain_app
  USING (
    brand_id IS NOT NULL
    AND brand_id = current_setting('app.current_brand_id', TRUE)::uuid
  );

REVOKE ALL ON invite FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON invite TO brain_app;

-- ── NN-1 assertion: all three GUC forms must use two-arg variant ──────────────
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
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting. '
      'Replace with two-arg form: current_setting(''guc_name'', TRUE)::uuid.',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;
