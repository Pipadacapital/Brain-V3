-- ============================================================================
-- 0113_provision_workspace.sql
-- Durable RLS-safe provisioning for the STANDALONE workspace-create path.
-- ============================================================================
--
-- DEFECT this closes: POST /api/v1/workspaces (WorkspaceService.create — creating an ADDITIONAL
-- workspace, not the first-run merged onboarding) inserts into organization + membership directly
-- under the non-superuser brain_app role. organization is FORCE ROW LEVEL SECURITY and its isolation
-- policy doubles as the INSERT WITH CHECK (id = current_setting('app.current_workspace_id')). The org
-- id is DB-generated, so there is NO way to set that GUC before the insert — the first insert has no
-- tenant context to satisfy and fails closed with 42501 "new row violates row-level security policy
-- for table organization". (It only ever appeared to work when the app ran as a superuser.)
--
-- This is the EXACT problem 0047 solved for the merged workspace+brand onboarding path via
-- provision_workspace_and_brand() — but the standalone workspace-only endpoint was never routed
-- through an equivalent. This adds the workspace-only sibling: a SECURITY DEFINER function that
-- creates the organization + org-level owner membership atomically as the privileged owner.
-- Authorization is the app's — the caller passes p_owner_user_id = the AUTHENTICATED session user, so
-- a caller can only ever provision a workspace owned by themselves; brain_app may EXECUTE it but cannot
-- write these FORCE-RLS tables directly for a tenant it has no context for.
--
-- onboarding_status lands at 'org_created' / step 1 atomically (the same end state the old service
-- reached via a separate advanceOnboardingStatus call). A duplicate slug raises 23505 — the caller
-- retries with a fresh random-suffixed slug (derived) or maps it to 409 (caller-supplied).
--
-- ADDITIVE ONLY. ROLLBACK: DROP FUNCTION provision_workspace(uuid, text, text, text);

CREATE OR REPLACE FUNCTION provision_workspace(
  p_owner_user_id  UUID,
  p_workspace_name TEXT,
  p_slug           TEXT,
  p_region_code    TEXT
) RETURNS TABLE (organization_id UUID, onboarding_status TEXT, onboarding_step INT)
  LANGUAGE plpgsql
  SECURITY DEFINER
  -- Same expanded search_path the schema-split re-created provision_workspace_and_brand with: the
  -- tables now live in tenancy (organization) + iam (membership), not public.
  SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config, identity, consent, pixel, data_plane
AS $$
DECLARE
  v_org UUID;
BEGIN
  INSERT INTO organization (name, slug, owner_user_id, region_code, onboarding_status, onboarding_step)
  VALUES (p_workspace_name, p_slug, p_owner_user_id, COALESCE(p_region_code, 'IN'), 'org_created', 1)
  RETURNING id INTO v_org;

  -- Org-level owner membership (brand_id NULL = org scope).
  INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
  VALUES (v_org, NULL, p_owner_user_id, 'owner');

  RETURN QUERY SELECT v_org, 'org_created'::TEXT, 1;
END;
$$;

GRANT EXECUTE ON FUNCTION provision_workspace(uuid, text, text, text) TO brain_app;

-- ── Assertions (mirror 0047) ───────────────────────────────────────────────────
DO $$
DECLARE v_secdef boolean; v_cfg text;
BEGIN
  SELECT p.prosecdef, array_to_string(p.proconfig, ',')
    INTO v_secdef, v_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'provision_workspace';
  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0113): provision_workspace() not found.';
  END IF;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'PROVISION GUARD (0113): provision_workspace() must be SECURITY DEFINER.';
  END IF;
  IF v_cfg IS NULL OR v_cfg NOT LIKE '%tenancy%' OR v_cfg NOT LIKE '%iam%' THEN
    RAISE EXCEPTION 'PROVISION GUARD (0113): provision_workspace() search_path must include tenancy + iam.';
  END IF;
END
$$;
