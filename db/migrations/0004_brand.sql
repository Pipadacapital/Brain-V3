-- ============================================================================
-- 0004_brand.sql — Brand table + membership.brand_id FK + brand membership rule
-- ============================================================================
-- Doc refs: 03-architecture-plan.md §4 Migration 003 / NN-1 / D0.3
--
-- Product term "Brand" → database table "brand" (D0.3).
-- Product term "Brand Member" → membership WHERE brand_id IS NOT NULL.
--
-- RLS: app.current_brand_id (two-arg fail-closed — NN-1).
--
-- Also adds the deferred FK: membership.brand_id → brand(id).
-- ============================================================================

-- ── brand — child of organization, brand-level tenant root ───────────────────
-- RLS: brand-scoped isolation (brand_id = current_setting('app.current_brand_id', TRUE)).
-- "brand = workspace" product equivalence (D0.3 — two-level hierarchy, not three).
CREATE TABLE IF NOT EXISTS brand (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organization(id),
  display_name    TEXT        NOT NULL,
  domain          TEXT        NULL,     -- pixel-verify target host; nullable
  status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'archived')),
  region_code     TEXT        NOT NULL DEFAULT 'IN',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS brand_organization_id_idx
  ON brand (organization_id);

-- RLS: brand-scoped isolation.
ALTER TABLE brand ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand FORCE ROW LEVEL SECURITY;

CREATE POLICY brand_isolation ON brand
  AS PERMISSIVE FOR ALL TO brain_app
  USING (id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON brand FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON brand TO brain_app;

-- ── Add deferred FK: membership.brand_id → brand(id) ─────────────────────────
-- This FK was deferred from migration 0003 because brand table did not exist yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'membership_brand_id_fkey'
      AND table_name = 'membership'
  ) THEN
    ALTER TABLE membership
      ADD CONSTRAINT membership_brand_id_fkey
      FOREIGN KEY (brand_id) REFERENCES brand(id);
  END IF;
END
$$;

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
