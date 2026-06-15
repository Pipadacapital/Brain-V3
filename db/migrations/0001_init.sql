-- ============================================================================
-- 0001_init.sql — RLS bootstrap + audit_log + brand_keyring (Sprint 0)
-- ============================================================================
-- Doc refs: doc 04 §F.1 / doc 05 §9 / INVARIANTS.md I-S01 / I-S06 / I-S09 / NN-1
--
-- Sprint-0 scope: template + audit_log + brand_keyring.
-- Full business tables (organization, brand, app_user, etc.) ship in M1.
--
-- IMMUTABLE INVARIANTS (never change without a Security VETO):
--   1. Two-arg current_setting('app.current_brand_id', TRUE) — NN-1 CRITICAL.
--      The TRUE (missing_ok) arg makes a missing GUC return NULL, not ERROR.
--      brand_id = NULL is always false by SQL null semantics => 0 rows returned.
--      The one-arg form THROWS on a missing GUC, which ORMs can catch/swallow,
--      creating a vector where the next query in the same pool slot sees all rows.
--
--   2. Non-owner app role — NEVER granted BYPASSRLS (I-S01).
--      The role owns no tables and has no DDL permissions.
--      BYPASSRLS must never appear in any migration for the app role.
--
--   3. audit_log — INSERT + SELECT only for the app role (I-S06).
--      NO UPDATE, DELETE, TRUNCATE. Append-only at the GRANT level.
--      Hash-chain columns ensure tamper-evidence.
--
--   4. brand_keyring — app role SELECT only (I-S09).
--      Wrapped DEKs are written by the key-management job, never by the app role.
-- ============================================================================

-- ── Enable required extensions ────────────────────────────────────────────────
-- pgcrypto is used for gen_random_uuid() and sha256 in hash-chain writes.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Non-owner application role ────────────────────────────────────────────────
-- The app connects as brain_app. It has no DDL permission and no BYPASSRLS.
-- GRANT brain_app TO <app_login_role> — done at provisioning time, not in migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    CREATE ROLE brain_app NOLOGIN;
  END IF;
END
$$;

-- Confirm BYPASSRLS is NOT granted (assertion — will raise if misconfigured).
DO $$
DECLARE
  has_bypass BOOLEAN;
BEGIN
  SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = 'brain_app';
  IF has_bypass THEN
    RAISE EXCEPTION 'INVARIANT VIOLATION: brain_app must NEVER have BYPASSRLS (I-S01)';
  END IF;
END
$$;

-- ── RLS policy template (NN-1 two-arg form — apply to EVERY brand-scoped table) ──
-- Pattern to apply in every future M1+ migration for brand-scoped tables:
--
--   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
--   CREATE POLICY tenant_isolation ON <t>
--     AS PERMISSIVE
--     FOR ALL
--     TO brain_app
--     USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
--
-- KEY: The second argument TRUE (missing_ok) is MANDATORY (NN-1).
-- DO NOT use current_setting('app.current_brand_id')::uuid (one-arg form).
-- The one-arg form raises an exception on a missing GUC; that exception
-- may be swallowed by the connection pool, allowing subsequent queries to
-- run without a brand_id filter — a cross-brand data exposure (P0).

-- ── audit_log — append-only, hash-chained (I-S06) ────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  -- Surrogate PK (immutable; never updated).
  id              BIGSERIAL       PRIMARY KEY,
  -- Tenant key — every audit entry scoped to a brand (I-S01).
  brand_id        UUID            NOT NULL,
  -- Actor context.
  actor_id        UUID            NULL,    -- NULL for system/job actions
  actor_role      TEXT            NOT NULL DEFAULT 'system',
  -- Action descriptor.
  action          TEXT            NOT NULL,  -- e.g. 'brand.created', 'metric.computed'
  entity_type     TEXT            NOT NULL,  -- e.g. 'brand', 'metric_definition'
  entity_id       TEXT            NOT NULL,  -- string-serialised entity identifier
  -- Payload (no raw PII — I-S02).
  payload         JSONB           NOT NULL DEFAULT '{}',
  -- Hash-chain columns (I-S06).
  -- prev_hash: sha256 of the previous row's entry_hash (NULL for the first row).
  prev_hash       TEXT            NULL,
  -- entry_hash: sha256(prev_hash || canonical(row)) — computed on insert.
  entry_hash      TEXT            NOT NULL,
  -- Immutable timestamp — set once, never updated.
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  -- Idempotency: callers may supply a key to deduplicate replays.
  idempotency_key TEXT            NULL UNIQUE
);

-- Audit_log is NOT brand-partitioned by RLS — it is the audit SoR for ALL brands.
-- The brain_app role gets INSERT + SELECT only (I-S06). NO UPDATE, NO DELETE.
-- Revoke all first to be safe (covers any accidental prior grants).
REVOKE ALL ON audit_log FROM brain_app;
GRANT INSERT, SELECT ON audit_log TO brain_app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO brain_app;

-- Disable RLS on audit_log intentionally — the audit log must record cross-brand
-- system events (e.g. key-rotation jobs). Row-level access control is enforced
-- at the application layer (the app role only INSERTs its own brand's rows; the
-- hash-chain is the tamper-evidence, not per-row isolation).
ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;

-- Indexes for fast lookups by brand and action.
CREATE INDEX IF NOT EXISTS audit_log_brand_action_idx
  ON audit_log (brand_id, action, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx
  ON audit_log (entity_type, entity_id, created_at DESC);

-- ── brand_keyring — per-brand wrapped DEK storage (I-S05 / I-S09) ────────────
-- Stores the KMS-wrapped data encryption key reference for each brand.
-- The wrapped DEK is written by the key-management provisioning job (never the app).
-- The app role gets SELECT only — it reads the wrapped DEK to derive the session key
-- via KMS GenerateDataKeyWithoutPlaintext (the plaintext DEK never leaves KMS).
CREATE TABLE IF NOT EXISTS brand_keyring (
  -- One row per brand; the brand_id IS the PK.
  brand_id        UUID        PRIMARY KEY,
  -- AWS KMS key ID (ARN or alias) of the CMK used to wrap this brand's DEK.
  kms_key_id      TEXT        NOT NULL,
  -- The base64-encoded KMS-wrapped (ciphertext) DEK blob.
  -- NEVER store the plaintext DEK here or anywhere in the DB (I-S09).
  wrapped_dek_b64 TEXT        NOT NULL,
  -- KMS key rotation version — bumped on each rotation event.
  key_version     INTEGER     NOT NULL DEFAULT 1,
  -- Whether the key is active. Deactivated on DPDP erasure (crypto-shred, I-S05).
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Timestamps.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- App role: SELECT only on brand_keyring (I-S09).
-- INSERT/UPDATE performed by the key-management provisioning job with its own role.
REVOKE ALL ON brand_keyring FROM brain_app;
GRANT SELECT ON brand_keyring TO brain_app;

-- brand_keyring is NOT RLS-protected at the Postgres level because the key-mgmt job
-- needs to write rows for any brand without a per-brand context.
-- The app role SELECT is scoped by its own WHERE clause (WHERE brand_id = $1).
ALTER TABLE brand_keyring DISABLE ROW LEVEL SECURITY;

-- ── _rls_demo — proves the RLS template works end-to-end ─────────────────────
-- This stub table exists solely to prove the RLS pattern in the isolation-fuzz test.
-- It ships empty; no data is written in Sprint 0.
-- Business tables (brand, organization, metric_definition, etc.) are M1.
CREATE TABLE IF NOT EXISTS _rls_demo (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id    UUID        NOT NULL,   -- tenant key (every brand-scoped table has this)
  payload     TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, id)
);

-- Apply RLS to the demo table using the NN-1 two-arg form.
ALTER TABLE _rls_demo ENABLE ROW LEVEL SECURITY;
ALTER TABLE _rls_demo FORCE ROW LEVEL SECURITY;

-- NN-1 CRITICAL: two-arg current_setting with TRUE (missing_ok).
-- A missing GUC returns NULL => brand_id = NULL => ALWAYS FALSE => 0 rows.
-- DO NOT change to current_setting('app.current_brand_id')::uuid (one-arg form).
CREATE POLICY tenant_isolation ON _rls_demo
  AS PERMISSIVE
  FOR ALL
  TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- App role gets full DML on the demo table for isolation-fuzz testing.
REVOKE ALL ON _rls_demo FROM brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON _rls_demo TO brain_app;

-- ── NN-1 assertion: no one-arg current_setting in any policy ─────────────────
-- This assertion fires at migration time if someone accidentally used the one-arg form.
-- It scans pg_policies for any policy whose USING clause contains the one-arg string.
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE qual LIKE '%current_setting(''app.current_brand_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%'
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting (missing_ok=false). '
      'Replace with current_setting(''app.current_brand_id'', TRUE)::uuid.',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;
