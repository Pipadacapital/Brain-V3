-- ============================================================================
-- 0013_brand_self_read.sql — Self-read RLS policy on brand
-- ============================================================================
-- Companion to 0008 (membership) / 0009 (organization). `brand` is RLS-scoped to
-- app.current_brand_id (0004 brand_isolation), so under the production brain_app
-- role a brand-summary / switcher query (SELECT ... FROM brand WHERE organization_id
-- = $1) returns ZERO rows — the active-brand GUC matches only ONE brand. This is a
-- latent prod defect in the existing brand-summary handler, exposed the moment a
-- second brand exists. Dev connects as superuser `brain` (bypasses RLS) and masks it.
--
-- Fix: a PERMISSIVE, SELECT-only policy letting a user read the brands in which they
-- hold a brand-level membership, scoped to the ACTIVE org via the workspace GUC.
-- Writes remain governed solely by brand_isolation (0004). Not a cross-tenant read.
--
-- Fail-closed (NN-1): two-arg current_setting(..., TRUE). Missing/NULL user OR
-- workspace GUC → subquery returns 0 rows → id IN (empty) is false → 0 brands.
--
-- SOFT-DELETE / ARCHIVED REGRESSION NOTE (MA-04b): the subquery predicates on
-- m.brand_id IS NOT NULL only. If `membership` ever gains a soft-delete column
-- (deleted_at / status), a revoked-then-soft-deleted member would re-appear in the
-- brand list. On any such migration you MUST add `AND m.deleted_at IS NULL` (or the
-- status equivalent) here, or removed users silently regain brand visibility.
-- (Archived BRANDS are intentionally still listable — the set-brand handler rejects
--  switching INTO an archived brand at the application layer, MA-10; an archived-brand
--  RLS join would add a cross-table check to a hot policy — avoided by design.)
-- ============================================================================

CREATE POLICY brand_self_read ON brand
  FOR SELECT
  TO brain_app
  USING (
    id IN (
      SELECT m.brand_id
      FROM membership m
      WHERE m.app_user_id = current_setting('app.current_user_id', TRUE)::uuid
        AND m.brand_id IS NOT NULL
        -- Scope to the ACTIVE org only; the workspace GUC is always set by
        -- sessionPreHandler before any protected BFF query runs (MA-04a).
        AND m.organization_id = current_setting('app.current_workspace_id', TRUE)::uuid
    )
  );

-- Negative-control sanity (NN-1): two-arg fail-closed form, BOTH GUCs.
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
  FROM pg_policies
  WHERE tablename = 'brand'
    AND policyname = 'brand_self_read'
    AND (
      (qual LIKE '%current_setting(''app.current_user_id'')%'
        AND qual NOT LIKE '%current_setting(''app.current_user_id'', true)%'
        AND qual NOT LIKE '%current_setting(''app.current_user_id'', TRUE)%')
      OR
      (qual LIKE '%current_setting(''app.current_workspace_id'')%'
        AND qual NOT LIKE '%current_setting(''app.current_workspace_id'', true)%'
        AND qual NOT LIKE '%current_setting(''app.current_workspace_id'', TRUE)%')
    );
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'brand_self_read uses one-arg current_setting (not fail-closed) — NN-1 violation';
  END IF;
END $$;
