-- ============================================================================
-- 0047_provision_workspace_and_brand.sql
-- feat-tenancy-runtime-brain-app (A1) — atomic provisioning under FORCE RLS
-- ============================================================================
--
-- The onboarding "create my first workspace + brand" flow inserts into organization, membership and
-- brand — all FORCE ROW LEVEL SECURITY. Their isolation policies double as the INSERT check
-- (`id = current_setting('app.current_<workspace|brand>_id')`), so under the non-superuser brain_app
-- role the FIRST insert has no tenant context to satisfy and fails closed. Today it only works because
-- the app connects as a superuser that bypasses RLS — which is exactly the R-01 hole we are closing.
--
-- The CORRECT, durable fix (same pattern as issue_invoice / list_active_brand_ids / resolve_merge_review):
-- a SECURITY DEFINER function that performs the whole provisioning atomically as the privileged owner.
-- Authorization is the app's: the BFF passes p_owner_user_id = the AUTHENTICATED session user, so a
-- caller can only ever provision a workspace owned by themselves. brain_app may EXECUTE it; it cannot
-- write these tables directly for a tenant it has no context for. Atomic: org + 2 memberships + brand
-- in one transaction, returning the ids the app needs for its post-commit side effects (audit, pixel).
--
-- ADDITIVE ONLY (I-E02). ROLLBACK: DROP FUNCTION provision_workspace_and_brand(uuid,text,text,text,text,text,char,text,text);

CREATE OR REPLACE FUNCTION provision_workspace_and_brand(
  p_owner_user_id      UUID,
  p_workspace_name     TEXT,
  p_slug               TEXT,
  p_brand_display_name TEXT,
  p_domain             TEXT,        -- nullable (skip-for-now creates no pixel/domain)
  p_region_code        TEXT,
  p_currency_code      CHAR(3),
  p_timezone           TEXT,
  p_revenue_definition TEXT
) RETURNS TABLE (organization_id UUID, brand_id UUID, onboarding_status TEXT)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_org   UUID;
  v_brand UUID;
BEGIN
  -- Organization. onboarding_status lands at 'brand_created' atomically (the intermediate
  -- 'org_created' is never observable in one transaction). A duplicate slug raises 23505 — the
  -- caller retries with a fresh slug (the random-suffix derivation makes this near-zero).
  INSERT INTO organization (name, slug, owner_user_id, region_code, onboarding_status, onboarding_step)
  VALUES (p_workspace_name, p_slug, p_owner_user_id, COALESCE(p_region_code, 'IN'), 'brand_created', 2)
  RETURNING id INTO v_org;

  -- Org-level owner membership.
  INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
  VALUES (v_org, NULL, p_owner_user_id, 'owner');

  -- Brand (1:1 brand:workspace for now — org→brand→website→pixel model).
  INSERT INTO brand (organization_id, display_name, domain, region_code, currency_code, timezone, revenue_definition)
  VALUES (v_org, p_brand_display_name, p_domain, COALESCE(p_region_code, 'IN'),
          COALESCE(p_currency_code, 'INR'), COALESCE(p_timezone, 'Asia/Kolkata'),
          COALESCE(p_revenue_definition, 'realized'))
  RETURNING id INTO v_brand;

  -- Brand-level owner membership.
  INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
  VALUES (v_org, v_brand, p_owner_user_id, 'owner');

  RETURN QUERY SELECT v_org, v_brand, 'brand_created'::TEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION
  provision_workspace_and_brand(uuid, text, text, text, text, text, char, text, text) TO brain_app;

-- ── Assertions ─────────────────────────────────────────────────────────────────
DO $$
DECLARE v_secdef boolean; v_cfg text;
BEGIN
  SELECT p.prosecdef, array_to_string(p.proconfig, ',')
    INTO v_secdef, v_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'provision_workspace_and_brand';
  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0047): provision_workspace_and_brand() not found.';
  END IF;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'PROVISION GUARD (0047): provision_workspace_and_brand() must be SECURITY DEFINER.';
  END IF;
  IF v_cfg IS NULL OR v_cfg NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'PROVISION GUARD (0047): provision_workspace_and_brand() must pin search_path=public.';
  END IF;
END
$$;
