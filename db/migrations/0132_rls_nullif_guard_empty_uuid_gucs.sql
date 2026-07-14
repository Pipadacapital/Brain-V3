--
-- 0132_rls_nullif_guard_empty_uuid_gucs.sql — stop RLS policies throwing on an empty user/workspace GUC.
--
-- BUG: connector sync/backfill SYSTEM jobs set only `app.current_brand_id` and leave
-- `app.current_user_id` / `app.current_workspace_id` UNSET (= ''). Postgres evaluates EVERY permissive
-- policy on a touched table, and 9 policies cast `current_setting('app.current_{user,workspace}_id', true)::uuid`.
-- An unset GUC is '' → `''::uuid` → **"invalid input syntax for type uuid: \"\""**, failing the whole
-- query (seen on the meta ad-insights, shopify/woo backfill paths). The throw happens during policy
-- EVALUATION, before the grant/deny decision — so it fires even for rows the job would never see.
--
-- FIX (defense-in-depth alongside the app-side buildContextGucSql work): wrap each cast in
-- `NULLIF(current_setting(...), '')` so an empty GUC becomes NULL instead of a cast error. Row
-- VISIBILITY is IDENTICAL: `col = NULL` is NULL (not true) → the same rows are hidden as before; the
-- only change is that policy evaluation no longer CRASHES on a system job that hasn't set the user GUC.
-- Non-empty GUCs are unaffected (NULLIF only rewrites the empty-string case).
--
-- Atomic: each DROP+CREATE is inside one transaction, so RLS is never unenforced for any window.
-- Every recreated policy is byte-identical to the baseline (0000) EXCEPT the NULLIF wrapper.
--
BEGIN;

-- iam.email_verification --------------------------------------------------------------------------
DROP POLICY IF EXISTS email_verification_isolation ON iam.email_verification;
CREATE POLICY email_verification_isolation ON iam.email_verification TO brain_app
  USING ((app_user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''))::uuid));

-- iam.invite --------------------------------------------------------------------------------------
DROP POLICY IF EXISTS invite_org_level ON iam.invite;
CREATE POLICY invite_org_level ON iam.invite TO brain_app
  USING (((brand_id IS NULL) AND (organization_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''))::uuid)));

-- iam.membership ----------------------------------------------------------------------------------
DROP POLICY IF EXISTS membership_isolation ON iam.membership;
CREATE POLICY membership_isolation ON iam.membership TO brain_app
  USING ((organization_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''))::uuid));

DROP POLICY IF EXISTS membership_self_read ON iam.membership;
CREATE POLICY membership_self_read ON iam.membership FOR SELECT TO brain_app
  USING ((app_user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''))::uuid));

-- iam.password_reset ------------------------------------------------------------------------------
DROP POLICY IF EXISTS password_reset_isolation ON iam.password_reset;
CREATE POLICY password_reset_isolation ON iam.password_reset TO brain_app
  USING ((app_user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''))::uuid));

-- iam.user_session --------------------------------------------------------------------------------
DROP POLICY IF EXISTS user_session_isolation ON iam.user_session;
CREATE POLICY user_session_isolation ON iam.user_session TO brain_app
  USING ((app_user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''))::uuid));

-- tenancy.brand -----------------------------------------------------------------------------------
DROP POLICY IF EXISTS brand_self_read ON tenancy.brand;
CREATE POLICY brand_self_read ON tenancy.brand FOR SELECT TO brain_app
  USING ((id IN ( SELECT m.brand_id
     FROM iam.membership m
    WHERE ((m.app_user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''))::uuid)
      AND (m.brand_id IS NOT NULL)
      AND (m.organization_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''))::uuid)))));

-- tenancy.organization ----------------------------------------------------------------------------
DROP POLICY IF EXISTS organization_isolation ON tenancy.organization;
CREATE POLICY organization_isolation ON tenancy.organization TO brain_app
  USING ((id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''))::uuid));

DROP POLICY IF EXISTS organization_self_read ON tenancy.organization;
CREATE POLICY organization_self_read ON tenancy.organization FOR SELECT TO brain_app
  USING ((id IN ( SELECT m.organization_id
     FROM iam.membership m
    WHERE (m.app_user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''))::uuid))));

COMMIT;
