-- 0067_audit_security_rls_isolation.sql
--
-- DB-AUDIT C1 — close cross-brand READ exposure on two tenant-keyed tables that shipped
-- WITHOUT row-level security. Found by the adversarial DB audit: any `brain_app` session could
-- SELECT every brand's rows from `audit.audit_log` (who-did-what trail) and `tenancy.brand_keyring`
-- (per-brand wrapped DEK references). Every other tenant-keyed table in the schema FORCEs RLS;
-- these two were oversights.
--
-- NOT in scope here: `data_plane.collector_spool` has NO brand_id by design (the pre-tenant-
-- resolution edge buffer — documented in pg-spool.repository.ts). RLS cannot scope it; it is
-- addressed by a retention reaper (DB-AUDIT M6), not isolation.
--
-- Idempotent: DROP POLICY IF EXISTS before CREATE; ENABLE/FORCE are no-ops if already set.

-- ── audit.audit_log ────────────────────────────────────────────────────────────────────────────
-- Brand-scoped for normal app sessions. The hourly WORM checkpoint job (apps/core jobs/audit-
-- checkpoint) walks the GLOBAL hash-chain (max id + count across ALL brands) and connects as
-- brain_app, so it gets a privileged read-all escape via the established `app.role` GUC convention
-- (contact_pii precedent, 0017) — value 'audit_reader'. Two-arg current_setting → missing GUC = NULL
-- = fail-closed (0 rows), never an error. WITH CHECK (TRUE): brand_id is stamped by the trusted,
-- hash-chained writer (@brain/audit) and the table is append-only at the GRANT level; the isolation
-- concern is cross-brand READ, which the USING clause closes.
ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_isolation ON audit.audit_log;
CREATE POLICY audit_log_isolation ON audit.audit_log
  AS PERMISSIVE FOR ALL TO brain_app
  USING (
    current_setting('app.role', TRUE) = 'audit_reader'
    OR brand_id = current_setting('app.current_brand_id', TRUE)::uuid
  )
  WITH CHECK (TRUE);

-- ── tenancy.brand_keyring ────────────────────────────────────────────────────────────────────────
-- Per-brand wrapped DEK material. Strict brand-scoped isolation on read AND write — the prod
-- KmsVaultKeyProvider reads it by brand_id inside the brand-scoped PII path (app.current_brand_id
-- is set), and provisioning runs under the new brand's context.
ALTER TABLE tenancy.brand_keyring ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.brand_keyring FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS brand_keyring_isolation ON tenancy.brand_keyring;
CREATE POLICY brand_keyring_isolation ON tenancy.brand_keyring
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)
  WITH CHECK (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- ── Guard: fail the migration unless both tables now FORCE RLS with a policy ──────────────────────
DO $$
BEGIN
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'audit.audit_log'::regclass) THEN
    RAISE EXCEPTION '0067 VIOLATION: audit.audit_log must FORCE ROW LEVEL SECURITY';
  END IF;
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'tenancy.brand_keyring'::regclass) THEN
    RAISE EXCEPTION '0067 VIOLATION: tenancy.brand_keyring must FORCE ROW LEVEL SECURITY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='audit' AND tablename='audit_log') THEN
    RAISE EXCEPTION '0067 VIOLATION: audit.audit_log missing RLS policy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenancy' AND tablename='brand_keyring') THEN
    RAISE EXCEPTION '0067 VIOLATION: tenancy.brand_keyring missing RLS policy';
  END IF;
END $$;
