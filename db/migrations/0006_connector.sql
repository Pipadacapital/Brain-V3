-- ============================================================================
-- 0006_connector.sql — Connector tables: connector_instance, connector_sync_status, connector_cursor
-- ============================================================================
-- Doc refs: 03-architecture-plan.md §4 Migration 005 / NN-1 / NN-2 / I-S09 / I-ST04
--
-- NN-2 CRITICAL: connector_instance MUST NOT have any column named:
--   oauth_token, *_token, *_ciphertext, *_secret, *_key
-- The ONLY credential reference is secret_ref (AWS Secrets Manager ARN).
-- Zero token bytes in Postgres. Semgrep DDL scan covers this file.
--
-- connector_cursor: idempotent upsert on (brand_id, connector_instance_id, resource) (I-ST04).
-- RLS: app.current_brand_id (two-arg fail-closed — NN-1).
-- ============================================================================

-- ── connector_instance — per-brand connector (RLS: app.current_brand_id) ─────
-- NN-2: secret_ref text NOT NULL is the ONLY credential reference (Secrets Manager ARN).
-- NO oauth_token, NO *_ciphertext, NO *_secret, NO *_key column (I-S09).
-- M1 supports Shopify only; CHECK (provider IN ('shopify')).
CREATE TABLE IF NOT EXISTS connector_instance (
  id                UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id          UUID        NOT NULL REFERENCES brand(id),
  provider          TEXT        NOT NULL CHECK (provider IN ('shopify')),
  shop_domain       TEXT        NOT NULL,
  -- NN-2: AWS Secrets Manager ARN — the ONLY credential reference.
  -- Zero token bytes stored in Postgres (I-S09).
  secret_ref        TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'connected'
                      CHECK (status IN ('connected', 'disconnected', 'error')),
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at   TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  -- One Shopify connection per brand in M1.
  CONSTRAINT connector_instance_brand_provider_unique UNIQUE (brand_id, provider)
);

CREATE INDEX IF NOT EXISTS connector_instance_brand_id_idx
  ON connector_instance (brand_id);

-- RLS: brand-scoped isolation.
ALTER TABLE connector_instance ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_instance FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_instance_isolation ON connector_instance
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON connector_instance FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON connector_instance TO brain_app;

-- ── connector_sync_status — per-brand sync state (RLS: app.current_brand_id) ──
CREATE TABLE IF NOT EXISTS connector_sync_status (
  id                      UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id                UUID        NOT NULL REFERENCES brand(id),
  connector_instance_id   UUID        NOT NULL REFERENCES connector_instance(id),
  state                   TEXT        NOT NULL DEFAULT 'waiting_for_data'
                            CHECK (state IN ('connected', 'syncing', 'waiting_for_data', 'error')),
  last_sync_at            TIMESTAMPTZ NULL,
  last_error              TEXT        NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS connector_sync_status_brand_connector_idx
  ON connector_sync_status (brand_id, connector_instance_id);

-- RLS: brand-scoped isolation.
ALTER TABLE connector_sync_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_sync_status FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_sync_status_isolation ON connector_sync_status
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON connector_sync_status FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON connector_sync_status TO brain_app;

-- ── connector_cursor — idempotent sync cursor (RLS: app.current_brand_id) ─────
-- Idempotency: UNIQUE (brand_id, connector_instance_id, resource) — the upsert key.
-- Replay-safe: re-inserting with the same key updates cursor_value (I-ST04).
CREATE TABLE IF NOT EXISTS connector_cursor (
  id                      UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id                UUID        NOT NULL REFERENCES brand(id),
  connector_instance_id   UUID        NOT NULL REFERENCES connector_instance(id),
  resource                TEXT        NOT NULL,  -- e.g. 'orders', 'products'
  cursor_value            TEXT        NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  -- The upsert key: unique per (brand, connector, resource).
  CONSTRAINT connector_cursor_upsert_key UNIQUE (brand_id, connector_instance_id, resource)
);

-- RLS: brand-scoped isolation.
ALTER TABLE connector_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_cursor FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_cursor_isolation ON connector_cursor
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON connector_cursor FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON connector_cursor TO brain_app;

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
