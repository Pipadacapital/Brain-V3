-- ============================================================================
-- 0009_organization_self_read.sql — Self-read RLS policy on organization
-- ============================================================================
-- Companion to 0008_membership_self_read.sql. `organization` is RLS-scoped to
-- app.current_workspace_id, so under the production brain_app role a user cannot
-- read the organizations they belong to until they already know the workspace id
-- — which breaks `listForUser` (the workspace list the onboarding/brand flow and
-- members UI depend on). NOTE: this only surfaces in production; dev connects as
-- the superuser `brain`, which bypasses RLS and masks it.
--
-- Fix: a PERMISSIVE, SELECT-only policy letting a user read the organizations in
-- which they hold a membership. The subquery reads `membership`, which is itself
-- governed by membership_self_read (0008) → it returns ONLY the requesting user's
-- own membership rows, so a user can read ONLY orgs they actually belong to.
-- Not a cross-tenant read.
--
-- Fail-closed (NN-1): two-arg current_setting(..., TRUE). A missing/NULL GUC →
-- the membership self-read returns 0 rows → `id IN (empty)` is false → 0 orgs.
--
-- PERMISSIVE + FOR SELECT: writes remain governed solely by organization_isolation
-- (workspace-scoped). No recursion risk: this policy reads `membership`; the
-- membership policies do not read `organization`.
-- ============================================================================

CREATE POLICY organization_self_read ON organization
  FOR SELECT
  TO brain_app
  USING (
    id IN (
      SELECT m.organization_id
      FROM membership m
      WHERE m.app_user_id = current_setting('app.current_user_id', TRUE)::uuid
    )
  );

-- Negative-control sanity (NN-1): two-arg fail-closed form.
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
  FROM pg_policies
  WHERE tablename = 'organization'
    AND policyname = 'organization_self_read'
    AND qual LIKE '%current_setting(''app.current_user_id'')%'
    AND qual NOT LIKE '%current_setting(''app.current_user_id'', true)%'
    AND qual NOT LIKE '%current_setting(''app.current_user_id'', TRUE)%';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'organization_self_read uses one-arg current_setting (not fail-closed) — NN-1 violation';
  END IF;
END $$;
