-- SPEC: A.1.5 (WA-12, mParticle-style ordered identity priority — per-brand, versioned)
-- ============================================================================
-- 0122_brand_identity_priority.sql — per-brand ORDERED identity priority config (versioned).
-- ============================================================================
-- WHAT: ops.brand_identity_priority — the per-brand ordered identity-priority config that the
--   stream-worker IdentityResolver walks when the `identity.priority_config` flag is ON (A.1.5).
--   `priority_order` is a JSONB ARRAY of identity-class names, highest precedence first, e.g.
--   ["platform_customer_id","email","phone","anonymous_id"] (the code default when NO row exists).
--
-- WHY a dedicated VERSIONED table (not columns on tenancy.brand like the phone-guard / consent
--   config): A.1.5 requires the priority config to be VERSIONED per brand — "changes append a
--   config-version row". tenancy.brand carries only current-value config (phone_guard_threshold /
--   suppression_window_days / identity_capture) with no history. So this is an APPEND-ONLY history:
--   a config change INSERTs a NEW (brand_id, version+1) row; the CURRENT config is the highest
--   version. The resolver stamps the resolved config `version` onto the identity_audit detail, so
--   every resolution is attributable to the exact config generation it ran under. This is
--   application-written operational state → PostgreSQL (the `ops` schema, 0116/0120 precedent), NOT
--   Iceberg/Trino (the medallion is the SoR for FACTS; a priority config is user-authored config).
--
-- DEFAULT: there is NO seed row. A brand that never customizes its order has no row here; the
--   resolver falls back to DEFAULT_IDENTITY_PRIORITY in code (implicit "version 0"). This keeps the
--   flag-OFF path byte-identical and means turning the flag ON with no stored row uses the spec
--   default order — no data migration, fully additive.
--
-- APPEND-ONLY: brain_app gets SELECT + INSERT only (NO UPDATE / NO DELETE) — the history is
--   immutable, mirroring the ledger tables. A new version is a new row.
--
-- RLS: FORCE (enforced even for the owner), brand_id isolation on app.current_brand_id, matching
--   ops.saved_segment (0120). The stream-worker reads it under the SAME brand GUC it already sets
--   for readBrandConfig (Neo4jIdentityRepository), and the app writes it under the brand-scoped pool.
--   NN-1 two-arg current_setting (missing GUC → NULL → 0 rows, fail-closed).
--
-- node-pg-migrate runs with session search_path = public only → every object is schema-qualified.
-- ADDITIVE. Rollback: DROP TABLE ops.brand_identity_priority (a user-authored config store, not a SoR).
-- ============================================================================

-- Up Migration

CREATE SCHEMA IF NOT EXISTS ops;
GRANT USAGE ON SCHEMA ops TO brain_app;

-- ── ops.brand_identity_priority — versioned, append-only per-brand priority order ──
CREATE TABLE IF NOT EXISTS ops.brand_identity_priority (
  brand_id       UUID        NOT NULL REFERENCES tenancy.brand(id),   -- tenant key / RLS anchor (I-S01)
  version        INT         NOT NULL,                                -- monotonic per brand, starts at 1
  priority_order JSONB       NOT NULL,                                -- ordered identity-class name array
  created_by     TEXT        NOT NULL DEFAULT 'system',               -- authoring actor (admin user / system)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, version),                                    -- append-only history; PK serves "latest"
  CONSTRAINT brand_identity_priority_version_positive CHECK (version >= 1),
  CONSTRAINT brand_identity_priority_order_is_array   CHECK (jsonb_typeof(priority_order) = 'array')
);

-- The PK (brand_id, version) is a btree that already serves the resolver's
-- "ORDER BY version DESC LIMIT 1 WHERE brand_id = $1" latest-version lookup — no extra index needed.

-- ── Tenant isolation — Postgres RLS (mirror ops.saved_segment / 0120) ─────────
ALTER TABLE ops.brand_identity_priority ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.brand_identity_priority FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS brand_identity_priority_isolation ON ops.brand_identity_priority;
CREATE POLICY brand_identity_priority_isolation ON ops.brand_identity_priority
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)        -- NN-1 two-arg fail-closed
  WITH CHECK (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);  -- writes pinned to session brand

-- brain_app grants: SELECT + INSERT only — the version history is APPEND-ONLY (no UPDATE / DELETE).
REVOKE ALL ON ops.brand_identity_priority FROM brain_app;
GRANT SELECT, INSERT ON ops.brand_identity_priority TO brain_app;

-- ── Post-condition guard: born-secure (RLS enabled + forced) ──────────────────
DO $$
DECLARE
  rls_enabled BOOLEAN;
  rls_forced  BOOLEAN;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity
  INTO rls_enabled, rls_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'ops' AND c.relname = 'brand_identity_priority';

  IF rls_enabled IS DISTINCT FROM TRUE OR rls_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      '0122 GUARD: ops.brand_identity_priority must be RLS ENABLED + FORCED (enabled=%, forced=%).',
      rls_enabled, rls_forced;
  END IF;
END
$$;

-- ── NN-1 assertion: no one-arg current_setting in the new policy ──────────────
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'ops' AND tablename = 'brand_identity_priority'
      AND qual LIKE '%current_setting(''app.current_brand_id'')%'
      AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
      AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%'
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting (0122 check).',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;

-- Down Migration

DROP TABLE IF EXISTS ops.brand_identity_priority;   -- reversible: user-authored config store, NOT a SoR
