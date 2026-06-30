-- ============================================================================
-- 0120_saved_segment.sql — P2 foundation: persisted customer SEGMENTS (operational state).
-- ============================================================================
-- WHAT: ops.saved_segment — one row per saved customer segment a user authors in the
--   Segments builder. `definition` is the JSONB rule tree (RFM / lifecycle / affinity /
--   churn predicates) the metric-engine re-evaluates at RUN TIME against the Silver spine —
--   Brain has NO permanent feature-precompute table, so the segment is stored as its RULE,
--   never as a materialized member list. This is APPLICATION-WRITTEN operational state, so it
--   lives in PostgreSQL (the `ops` schema, established in 0116), NOT in Iceberg/Trino. The
--   medallion (Bronze/Silver/Gold) is the system of record for facts; a saved segment is a
--   user-authored query definition — operational, mutable, brand-scoped.
--
-- WHY ops (not a Gold mart): segments are CRUD'd by the BFF on behalf of an authenticated
--   user (create / rename / edit rule tree / delete). They are read back per brand and are
--   never an analytical fact. PG is the SOLE operational store (CLAUDE.md: operational state
--   is PostgreSQL — the ops schema). The segment's RESULTS are computed live over the Gold/
--   Silver serving views; only the DEFINITION persists here.
--
-- RLS: FORCE (enforced even for the table owner — superuser BYPASS only), mirroring the
--   jobs.resource_backfill_state precedent (0111). UNLIKE the cross-brand ETL tables in 0116
--   (identity/journey projections, written by trusted all-brand jobs with NO brand GUC and so
--   deliberately left without RLS), saved_segment is accessed EXCLUSIVELY through the brand-
--   scoped app pool, which always SETs app.current_brand_id from the session (D-1; brand_id is
--   NEVER taken from the request body/header). So a born-secure FORCE-RLS isolation policy on
--   brand_id is correct and fail-closed: a missing GUC → NULL → 0 rows (NN-1 two-arg form).
--
-- GRANTS: brain_app gets SELECT + INSERT + UPDATE + DELETE — a user owns their segments and may
--   delete them (contrast the append-only ledgers / resumable state which withhold DELETE).
--
-- node-pg-migrate runs with session search_path = public only, so every object below is
--   schema-qualified `ops.`. The brand-scoped app accesses it as the qualified ops.saved_segment
--   (the same posture the 0116 ops.* tables use). Idempotent: CREATE ... IF NOT EXISTS throughout.
--
-- NN-1: the isolation policy uses the two-arg current_setting('app.current_brand_id', TRUE)
--   fail-closed form (missing GUC → NULL → no rows), matching every other brand-isolated table.
-- ============================================================================

-- Up Migration

CREATE SCHEMA IF NOT EXISTS ops;
GRANT USAGE ON SCHEMA ops TO brain_app;

-- ── ops.saved_segment — persisted customer-segment definitions (RLS: app.current_brand_id) ──
CREATE TABLE IF NOT EXISTS ops.saved_segment (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id    UUID        NOT NULL REFERENCES tenancy.brand(id),   -- tenant key / RLS anchor (I-S01)
  name        TEXT        NOT NULL,
  definition  JSONB       NOT NULL,                                -- RFM/lifecycle/affinity/churn rule tree
  created_by  UUID        NOT NULL REFERENCES iam.app_user(id),    -- authoring user (session actor)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

-- Per-brand listing index (RLS predicate + "my segments, newest first").
CREATE INDEX IF NOT EXISTS saved_segment_brand_idx
  ON ops.saved_segment (brand_id, created_at DESC);

-- ── Tenant isolation — Postgres RLS ─────────────────────────────────────────
-- FORCE: enforced even for the table owner (brain_app is the only runtime accessor).
-- Two-arg current_setting (NN-1): missing GUC → NULL → fail-closed → 0 rows.
ALTER TABLE ops.saved_segment ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.saved_segment FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS saved_segment_isolation ON ops.saved_segment;
CREATE POLICY saved_segment_isolation ON ops.saved_segment
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)        -- NN-1 two-arg fail-closed
  WITH CHECK (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);  -- writes pinned to the session brand

-- brain_app grants: full CRUD (a user owns + may delete their segments).
REVOKE ALL ON ops.saved_segment FROM brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.saved_segment TO brain_app;

-- ── Post-condition guard: table is born-secure (RLS enabled + forced) ─────────
DO $$
DECLARE
  rls_enabled BOOLEAN;
  rls_forced  BOOLEAN;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity
  INTO rls_enabled, rls_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'ops' AND c.relname = 'saved_segment';

  IF rls_enabled IS DISTINCT FROM TRUE OR rls_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      '0120 GUARD: ops.saved_segment must be RLS ENABLED + FORCED (enabled=%, forced=%).',
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
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE schemaname = 'ops' AND tablename = 'saved_segment'
      AND qual LIKE '%current_setting(''app.current_brand_id'')%'
      AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
      AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%'
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting (0120 check).',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;

-- Down Migration

DROP TABLE IF EXISTS ops.saved_segment;   -- reversible: a user-authored definition store, NOT a source of truth
