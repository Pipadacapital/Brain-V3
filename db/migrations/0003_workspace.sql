-- ============================================================================
-- 0003_workspace.sql — Workspace tables: organization, membership
-- ============================================================================
-- Doc refs: 03-architecture-plan.md §4 Migration 002 / NN-1 / D0.3
--
-- Product term "Workspace" → database table "organization" (D0.3).
-- Product term "Workspace Member" → membership WHERE brand_id IS NULL.
--
-- RLS: app.current_workspace_id (two-arg fail-closed — NN-1).
--
-- role_code CHECK: exactly ('owner','brand_admin','manager','analyst') — D0.2.
--   UI labels: owner→Owner, brand_admin→Admin, manager→Manager, analyst→Analyst.
-- ============================================================================

-- ── organization — top-level tenant root (RLS: app.current_workspace_id) ─────
-- Exactly-one-Owner invariant enforced at service layer (not DB constraint).
-- owner_user_id = the founding owner; always set, never null.
CREATE TABLE IF NOT EXISTS organization (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  slug            TEXT        NOT NULL,
  owner_user_id   UUID        NOT NULL REFERENCES app_user(id),
  region_code     TEXT        NOT NULL DEFAULT 'IN',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  CONSTRAINT organization_slug_unique UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS organization_owner_user_id_idx
  ON organization (owner_user_id);

-- RLS: workspace-scoped isolation.
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_isolation ON organization
  AS PERMISSIVE FOR ALL TO brain_app
  USING (id = current_setting('app.current_workspace_id', TRUE)::uuid);

REVOKE ALL ON organization FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON organization TO brain_app;

-- ── membership — single table for org-level AND brand-level membership ────────
-- brand_id IS NULL → org-level (workspace member).
-- brand_id IS NOT NULL → brand-level (brand member).
-- FK to brand(id) is added in 0004_brand.sql (deferred — brand table not yet created).
-- role_code CHECK: the 4 canon codes only (D0.2 / ADR-006).
CREATE TABLE IF NOT EXISTS membership (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organization(id),
  brand_id        UUID        NULL, -- FK to brand(id) added in migration 0004
  app_user_id     UUID        NOT NULL REFERENCES app_user(id),
  role_code       TEXT        NOT NULL
                    CHECK (role_code IN ('owner', 'brand_admin', 'manager', 'analyst')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

-- Compound unique: one role per (org, brand, user).
-- brand_id IS NOT NULL variant (standard unique index).
CREATE UNIQUE INDEX IF NOT EXISTS membership_org_brand_user_uniq
  ON membership (organization_id, brand_id, app_user_id)
  WHERE brand_id IS NOT NULL;

-- brand_id IS NULL variant: one org-level membership per (org, user).
-- NULL values are NOT considered equal by UNIQUE constraints, so we need a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS membership_org_user_uniq
  ON membership (organization_id, app_user_id)
  WHERE brand_id IS NULL;

CREATE INDEX IF NOT EXISTS membership_organization_id_idx
  ON membership (organization_id);

CREATE INDEX IF NOT EXISTS membership_brand_id_idx
  ON membership (brand_id)
  WHERE brand_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS membership_app_user_id_idx
  ON membership (app_user_id);

-- RLS: workspace-scoped isolation (member rows are scoped by organization_id).
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;

CREATE POLICY membership_isolation ON membership
  AS PERMISSIVE FOR ALL TO brain_app
  USING (organization_id = current_setting('app.current_workspace_id', TRUE)::uuid);

-- Member removal is a DELETE; sole-Owner guard at service layer.
REVOKE ALL ON membership FROM brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON membership TO brain_app;

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
