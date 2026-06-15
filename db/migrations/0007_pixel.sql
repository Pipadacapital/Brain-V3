-- ============================================================================
-- 0007_pixel.sql — Pixel tables: pixel_installation, pixel_status
-- ============================================================================
-- Doc refs: 03-architecture-plan.md §4 Migration 006 / NN-1
--
-- Pixel scope in M1: migration + verify endpoint + status page.
-- Full brain.js SDK is the M1-data-spine deliverable (separate requirement).
--
-- install_token: per-brand pixel tag identifier embedded in the snippet.
--   NOT a secret — it is a public identifier like a tracking ID.
-- RLS: app.current_brand_id (two-arg fail-closed — NN-1).
-- ============================================================================

-- ── pixel_installation — per-brand pixel installation record ──────────────────
-- One installation per brand (UNIQUE brand_id constraint).
-- install_token = gen_random_uuid() — public identifier for the pixel snippet (NOT a secret).
CREATE TABLE IF NOT EXISTS pixel_installation (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id        UUID        NOT NULL REFERENCES brand(id),
  install_token   UUID        NOT NULL DEFAULT gen_random_uuid(),
  target_host     TEXT        NOT NULL,
  installed_at    TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  CONSTRAINT pixel_installation_brand_unique UNIQUE (brand_id)
);

CREATE INDEX IF NOT EXISTS pixel_installation_brand_id_idx
  ON pixel_installation (brand_id);

-- RLS: brand-scoped isolation.
ALTER TABLE pixel_installation ENABLE ROW LEVEL SECURITY;
ALTER TABLE pixel_installation FORCE ROW LEVEL SECURITY;

CREATE POLICY pixel_installation_isolation ON pixel_installation
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON pixel_installation FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON pixel_installation TO brain_app;

-- ── pixel_status — per-brand pixel verification status ───────────────────────
CREATE TABLE IF NOT EXISTS pixel_status (
  id                      UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id                UUID        NOT NULL REFERENCES brand(id),
  pixel_installation_id   UUID        NOT NULL REFERENCES pixel_installation(id),
  state                   TEXT        NOT NULL DEFAULT 'waiting_for_data'
                            CHECK (state IN ('connected', 'syncing', 'waiting_for_data', 'error')),
  verified_at             TIMESTAMPTZ NULL,
  last_error              TEXT        NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS pixel_status_brand_id_idx
  ON pixel_status (brand_id);

-- RLS: brand-scoped isolation.
ALTER TABLE pixel_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE pixel_status FORCE ROW LEVEL SECURITY;

CREATE POLICY pixel_status_isolation ON pixel_status
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON pixel_status FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON pixel_status TO brain_app;

-- ── NN-1 assertion ────────────────────────────────────────────────────────────
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
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting.',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;
