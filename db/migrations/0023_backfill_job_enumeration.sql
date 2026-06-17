-- ============================================================================
-- 0023_backfill_job_enumeration.sql — SECURITY DEFINER backfill-job enumeration fn
-- feat-connector-backfill BOUNCE r1 — SEC-BF-H1 fix
-- ============================================================================
-- Problem (SEC-BF-H1):
--   backfill_job has ENABLE + FORCE ROW LEVEL SECURITY with the two-arg
--   fail-closed policy:
--     USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)
--   The backfill worker's poll loop calls findQueuedJob() on the brain_app pool
--   WITHOUT setting app.current_brand_id first (at enumeration time, no brand
--   is yet known — we are DISCOVERING which brand to work for). With no GUC:
--     current_setting('app.current_brand_id', TRUE) → NULL
--     NULL::uuid comparison → FALSE for every row
--   → 0 rows always → worker exits with "no queued jobs found" on every
--     invocation → backfill pipeline is completely non-functional in production.
--
--   This is the third occurrence of this system-job-under-FORCE-RLS pattern.
--   The previous two were fixed in 0019 (list_active_brand_ids for the
--   revenue-finalization + phone-guard-reeval cron jobs).
--
-- Fix:
--   Create list_queued_backfill_jobs() as SECURITY DEFINER owned by the
--   migration owner (superuser 'brain'). SECURITY DEFINER causes the function
--   to execute with the *definer's* privileges, bypassing FORCE RLS for this
--   enumeration step only.
--
--   The function returns ONLY dispatch metadata:
--     id (UUID)                    — the backfill_job PK
--     brand_id (UUID)              — needed to set the GUC before brand-scoped reads
--     connector_instance_id (UUID) — needed to claim the job + load the connector
--   for jobs in status 'queued' or 'running', ordered by creation time.
--
--   NO tenant data beyond dispatch identifiers is exposed — no progress numbers,
--   no cursor_value, no secrets. This is analogous to list_active_brand_ids()
--   which exposes only operational config columns (no PII, no tenant content).
--
--   After enumerating via this fn, the worker immediately sets the brand GUC
--   (set_config('app.current_brand_id', brand_id, true)) BEFORE any brand-scoped
--   read/write (claimQueued, loadConnectorInstance, LedgerWriter). All subsequent
--   operations are correctly gated by the RLS policy.
--
-- Search-path safety (SECURITY DEFINER hijack prevention):
--   SET search_path = public is pinned on the function to prevent search_path
--   hijacking attacks where a malicious schema shadows 'backfill_job'. With a
--   pinned search_path the function always resolves backfill_job from the public
--   schema only. Mirrors the approach in 0019.
--
-- GRANT EXECUTE TO brain_app: brain_app calls the fn from its connection pool.
--
-- ADDITIVE ONLY (I-E02): CREATE OR REPLACE FUNCTION. 0022 untouched.
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS list_queued_backfill_jobs();
-- ============================================================================

CREATE OR REPLACE FUNCTION list_queued_backfill_jobs()
  RETURNS TABLE(
    id                     uuid,
    brand_id               uuid,
    connector_instance_id  uuid
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT
    id,
    brand_id,
    connector_instance_id
  FROM backfill_job
  WHERE status IN ('queued', 'running')
  ORDER BY created_at ASC
$$;

-- brain_app must have EXECUTE to call the function from its connection pool.
GRANT EXECUTE ON FUNCTION list_queued_backfill_jobs() TO brain_app;

-- ── Migration-time assertion: fn is SECURITY DEFINER with pinned search_path ──
DO $$
DECLARE
  fn_config    TEXT;
  fn_security  TEXT;
BEGIN
  SELECT
    p.prosecdef::text,
    array_to_string(p.proconfig, ', ')
  INTO fn_security, fn_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_queued_backfill_jobs'
    AND n.nspname = 'public';

  IF fn_security IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SEC-BF-H1 GUARD: list_queued_backfill_jobs() must be SECURITY DEFINER '
      '(prosecdef=true). Got: %', fn_security;
  END IF;

  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'SEC-BF-H1 GUARD: list_queued_backfill_jobs() must have SET search_path = public '
      'to prevent SECURITY DEFINER search-path hijack. Got config: %', fn_config;
  END IF;
END
$$;

-- ── Migration-time assertion: brain_app has EXECUTE ──────────────────────────
DO $$
DECLARE
  has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege('brain_app', 'list_queued_backfill_jobs()', 'EXECUTE')
  INTO has_execute;

  IF NOT has_execute THEN
    RAISE EXCEPTION
      'SEC-BF-H1 GUARD: brain_app does not have EXECUTE on list_queued_backfill_jobs(). '
      'GRANT EXECUTE may have failed.';
  END IF;
END
$$;

-- ── Migration-time assertion: function returns only dispatch columns, not PII ─
-- Verify the function signature returns exactly (id uuid, brand_id uuid,
-- connector_instance_id uuid) — no data-content columns.
DO $$
DECLARE
  col_count INT;
BEGIN
  SELECT count(*)
  INTO col_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN information_schema.routines r
    ON r.routine_name = p.proname
    AND r.routine_schema = n.nspname
  WHERE p.proname = 'list_queued_backfill_jobs'
    AND n.nspname = 'public';

  -- Function must exist (col_count >= 1 confirms the above assertions passed)
  IF col_count = 0 THEN
    RAISE EXCEPTION
      'SEC-BF-H1 GUARD: list_queued_backfill_jobs() not found after creation.';
  END IF;
END
$$;
