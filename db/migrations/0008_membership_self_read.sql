-- ============================================================================
-- 0008_membership_self_read.sql — Self-read RLS policy on membership
-- ============================================================================
-- Problem: `organization` and `membership` are RLS-scoped to
-- app.current_workspace_id. At login a user has no workspace GUC yet, so they
-- cannot discover which workspace/brand they belong to — the session can never
-- bootstrap brand_id/role, and every role-gated route 403s forever.
--
-- Fix: a PERMISSIVE, SELECT-only policy letting a user read their OWN membership
-- rows, keyed on app.current_user_id — the same self-read GUC already used by
-- user_session, password_reset, email_verification (see 0002_auth.sql). This
-- exposes ONLY the requesting user's own membership rows. It does NOT widen
-- visibility of:
--   - other users' membership rows (predicate pins app_user_id = self),
--   - the organization table (untouched — still workspace-scoped),
--   - the brand table (untouched — still brand/workspace-scoped),
--   - any tenant business data.
-- A user reading their own membership is not a cross-tenant read; it is the
-- minimum needed to answer "which workspace/brand am I in?" after login.
--
-- Fail-closed (NN-1): two-arg current_setting(..., TRUE) → a missing/NULL GUC
-- yields NULL, the predicate is false, and 0 rows are returned.
--
-- PERMISSIVE + FOR SELECT: writes (INSERT/UPDATE/DELETE) remain governed solely
-- by membership_isolation (workspace-scoped) — this policy adds no write path.
-- For SELECT, Postgres ORs the permissive policies: a row is visible if it is in
-- the active workspace (membership_isolation) OR it belongs to the requesting
-- user (membership_self_read).
-- ============================================================================

CREATE POLICY membership_self_read ON membership
  FOR SELECT
  TO brain_app
  USING (app_user_id = current_setting('app.current_user_id', TRUE)::uuid);

-- Negative-control sanity (NN-1): the predicate uses the two-arg fail-closed form.
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
  FROM pg_policies
  WHERE tablename = 'membership'
    AND policyname = 'membership_self_read'
    AND qual LIKE '%current_setting(''app.current_user_id'')%'
    AND qual NOT LIKE '%current_setting(''app.current_user_id'', true)%'
    AND qual NOT LIKE '%current_setting(''app.current_user_id'', TRUE)%';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'membership_self_read uses one-arg current_setting (not fail-closed) — NN-1 violation';
  END IF;
END $$;
