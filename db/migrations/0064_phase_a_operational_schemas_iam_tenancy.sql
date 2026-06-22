-- 0064_phase_a_operational_schemas_iam_tenancy.sql
--
-- RE-PLATFORM PHASE A — PG operational-schema split (slice 2 of N: iam + tenancy).
--
-- Builds on 0063 (which created the 7 schemas, widened the role search_path, and set default grants).
-- This slice relocates the identity/auth tables → `iam` and the tenant-structure tables → `tenancy`,
-- via ALTER TABLE ... SET SCHEMA (RLS policies, triggers, FKs, indexes travel with the table; grants
-- are preserved). No iam/tenancy table owns a sequence and no view depends on them (verified).
--
-- FUNCTION HARDENING: 0063 only re-pinned the connector/jobs SECURITY DEFINER functions. The remaining
-- SECURITY DEFINER functions still pin search_path=public, and several read tables that move in THIS
-- slice (brand, organization, app_user) or in later slices (billing/audit ledgers). We widen ALL of
-- them to the full operational search_path in one pass — a fixed set of our own schemas (injection-safe)
-- — so no current-or-future slice can break a function via a relocated table. Owner/security unchanged.
--
-- Reverse = SET SCHEMA public + (functions already tolerate public being present). Data is disposable.

-- ── 1. Widen every remaining SECURITY DEFINER function still pinned to search_path=public ──
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.proconfig IS NOT NULL
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=public')
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config',
      r.sig
    );
  END LOOP;
END $$;

-- ── 2. Relocate identity/auth tables → iam ──
ALTER TABLE app_user           SET SCHEMA iam;
ALTER TABLE user_session       SET SCHEMA iam;
ALTER TABLE email_verification SET SCHEMA iam;
ALTER TABLE password_reset     SET SCHEMA iam;
ALTER TABLE invite             SET SCHEMA iam;
ALTER TABLE membership         SET SCHEMA iam;

-- ── 3. Relocate tenant-structure tables → tenancy ──
ALTER TABLE organization SET SCHEMA tenancy;
ALTER TABLE brand        SET SCHEMA tenancy;
ALTER TABLE brand_keyring SET SCHEMA tenancy;
