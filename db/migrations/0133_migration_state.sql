-- ============================================================================
-- 0133_migration_state.sql — Additive: ops.migration_state
--
-- One-shot idempotency guard for boot-time data migrations that must run
-- exactly once per deployment (e.g. bootstrap/reconnect-shopify-byo.ts).
--
-- Why not a DDL migration table? DDL migrations are handled by the migrator
-- runner. This is for DATA migrations that run at Core API bootstrap and need
-- a persistent "already applied" marker. Small, ops-only, no RLS (superuser).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.migration_state (
  key         TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE ops.migration_state IS
  'Boot-time data migration idempotency markers. See apps/core/src/bootstrap/*.ts.';

-- The Core API boot task runs as brain_app (NOSUPERUSER): it must read the marker and insert
-- it after applying. No UPDATE/DELETE — markers are write-once (0116 grant pattern).
GRANT USAGE ON SCHEMA ops TO brain_app;
GRANT SELECT, INSERT ON ops.migration_state TO brain_app;
