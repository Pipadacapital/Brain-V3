-- ============================================================================
-- 0019_active_brand_enumeration.sql — SECURITY DEFINER brand-enumeration fn
-- feat-realized-revenue-ledger BOUNCE r1 — F-SEC-01 fix
-- ============================================================================
-- Problem (F-SEC-01):
--   The brand table has ENABLE + FORCE ROW LEVEL SECURITY. brain_app with no
--   app.current_brand_id GUC set receives 0 rows from a bare
--     SELECT id FROM brand WHERE status = 'active'
--   System CronJobs (revenue-finalization, phone-guard-reeval) need to enumerate
--   ALL active brands before scoping down per-brand. A bare SELECT under FORCE
--   RLS is always a no-op for cross-tenant system jobs.
--
-- Fix:
--   Create list_active_brand_ids() as SECURITY DEFINER owned by the migration
--   owner (superuser 'brain'). SECURITY DEFINER causes the function to execute
--   with the *definer's* privileges, bypassing the caller's RLS for the brand-id
--   list only. No PII, no tenant data — the function returns only:
--     id (UUID) + operational finalization-config columns
--     (cod_recognition_horizon_days, prepaid_recognition_horizon_days, currency_code)
--   Cross-tenant system jobs enumerate tenants via this fn, then scope every
--   subsequent query (ledger read, ledger write) with the per-brand GUC.
--   No display_name, domain, organization_id, or any PII is exposed.
--
-- Search-path safety (SECURITY DEFINER hijack prevention):
--   SET search_path = public is pinned on the function to prevent search_path
--   hijacking attacks where a malicious schema shadows 'brand'. With a pinned
--   search_path the function always resolves brand from the public schema only.
--
-- Cross-tenant system jobs using this fn:
--   - apps/stream-worker/src/jobs/revenue-finalization.ts  (this fix)
--   - apps/stream-worker/src/jobs/phone-guard-reeval.ts    (follow-up — same pattern)
--
-- GRANT EXECUTE TO brain_app: brain_app calls the fn from its connection pool.
--
-- ADDITIVE ONLY (I-E02): CREATE OR REPLACE FUNCTION.
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS list_active_brand_ids();
-- ============================================================================

-- Cross-tenant system jobs (finalization, phone-guard-reeval) enumerate tenants
-- via this fn, never a bare brain_app SELECT under FORCE RLS.
-- Returns: id + operational config columns needed for finalization; no PII.
-- DROP first because CREATE OR REPLACE cannot change the return type (TABLE vs
-- SETOF uuid would conflict if this migration is re-run on a DB that has the
-- earlier SETOF uuid version from a partial apply).
DROP FUNCTION IF EXISTS list_active_brand_ids();
CREATE OR REPLACE FUNCTION list_active_brand_ids()
  RETURNS TABLE(
    id                              uuid,
    cod_recognition_horizon_days    int,
    prepaid_recognition_horizon_days int,
    currency_code                   char(3)
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT
    id,
    cod_recognition_horizon_days,
    prepaid_recognition_horizon_days,
    currency_code
  FROM brand
  WHERE status = 'active'
$$;

-- brain_app must have EXECUTE to call the function from its connection pool.
GRANT EXECUTE ON FUNCTION list_active_brand_ids() TO brain_app;

-- ── Migration-time assertion: fn is SECURITY DEFINER with pinned search_path ──
DO $$
DECLARE
  fn_config TEXT;
  fn_security TEXT;
BEGIN
  SELECT
    p.prosecdef::text,
    array_to_string(p.proconfig, ', ')
  INTO fn_security, fn_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_active_brand_ids'
    AND n.nspname = 'public';

  IF fn_security IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'F-SEC-01 GUARD: list_active_brand_ids() must be SECURITY DEFINER (prosecdef=true). '
      'Got: %', fn_security;
  END IF;

  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'F-SEC-01 GUARD: list_active_brand_ids() must have SET search_path = public '
      'to prevent SECURITY DEFINER search-path hijack. Got config: %', fn_config;
  END IF;
END
$$;

-- ── Migration-time assertion: brain_app has EXECUTE ───────────────────────────
DO $$
DECLARE
  has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege('brain_app', 'list_active_brand_ids()', 'EXECUTE')
  INTO has_execute;

  IF NOT has_execute THEN
    RAISE EXCEPTION
      'F-SEC-01 GUARD: brain_app does not have EXECUTE on list_active_brand_ids(). '
      'GRANT EXECUTE may have failed.';
  END IF;
END
$$;
