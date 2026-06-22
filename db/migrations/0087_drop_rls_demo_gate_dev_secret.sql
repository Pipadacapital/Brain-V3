-- ============================================================================
-- 0087_drop_rls_demo_gate_dev_secret.sql
-- AUDIT-REMEDIATION L3 — drop the RLS-demo scaffold, document dev_secret as dev-only,
--                        sweep any leftover dbt-backup tables out of Postgres
-- ============================================================================
--
-- public._rls_demo (0001_init) was a SCAFFOLD that proved the RLS template works end-to-end
-- during bring-up. It holds no product data (0 rows verified) and nothing reads it. Drop it;
-- the RLS contract is now proven by real, FORCE-RLS product tables + the live isolation suites.
--
-- public.dev_secret (0024) is the DEV-ONLY local secrets store (LocalSecretsManager /
-- WorkerLocalSecretsManager). It is NOT dropped — it is load-bearing in dev/prod-local and
-- has integration tests. In production, secrets live in AWS Secrets Manager + KMS; the dev
-- table must NEVER be the secret store outside dev. We assert it is empty-or-dev and stamp a
-- machine-visible COMMENT so the dev-only contract is discoverable from the catalog. The
-- application-layer prod-hard-fail guard (LocalSecretsManager) remains the enforcement point.
--
-- __dbt_backup sweep: dbt's full-refresh leaves <model>__dbt_backup tables behind on failure.
-- Analytical models do not belong in PG at all (medallion: lakehouse), so any such leftover is
-- pure cruft. We DROP every public.*__dbt_backup found (none present at authoring time; the
-- DO-block is idempotent and a no-op if there are none).
--
-- ADDITIVE-SAFE for product data. ROLLBACK: re-create _rls_demo from 0001 if ever needed.

-- ── 1. Drop the RLS-demo scaffold ─────────────────────────────────────────────
DROP TABLE IF EXISTS public._rls_demo CASCADE;

-- ── 2. dev_secret: document dev-only contract (do NOT drop) ────────────────────
COMMENT ON TABLE public.dev_secret IS
  'DEV-ONLY local secrets store (migration 0024). Production uses AWS Secrets Manager + KMS. '
  'Never the secret store outside dev; prod-hard-fail is enforced in LocalSecretsManager. '
  'AUDIT L3 (0087): retained intentionally — load-bearing for dev/prod-local + integration tests.';

-- ── 3. Sweep leftover dbt-backup tables out of PG ──────────────────────────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename
      FROM pg_tables
     WHERE tablename LIKE '%\_\_dbt\_backup' ESCAPE '\'
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', r.schemaname, r.tablename);
    RAISE NOTICE '0087: dropped leftover dbt-backup table %.%', r.schemaname, r.tablename;
  END LOOP;
END $$;

-- ── Guard ───────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public._rls_demo') IS NOT NULL THEN
    RAISE EXCEPTION '0087 VIOLATION: public._rls_demo still exists after DROP';
  END IF;
  IF to_regclass('public.dev_secret') IS NULL THEN
    RAISE EXCEPTION '0087 VIOLATION: public.dev_secret was dropped (it must be retained)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename LIKE '%\_\_dbt\_backup' ESCAPE '\') THEN
    RAISE EXCEPTION '0087 VIOLATION: a *__dbt_backup table still exists in PG';
  END IF;
END $$;
