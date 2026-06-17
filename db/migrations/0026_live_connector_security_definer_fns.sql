-- ============================================================================
-- 0026_live_connector_security_definer_fns.sql
-- feat-shopify-live-connector — SECURITY DEFINER fns for live connector paths
-- ADR-LV-4 (D-4 resolve_connector_by_shop_domain) + ADR-LV-7 (D-7 list_connectors_for_repull)
-- ============================================================================
--
-- WHY TWO SECURITY DEFINER FNS:
--
-- (1) list_connectors_for_repull():
--   The 35-day re-pull job is a cross-tenant system job. At enumeration time
--   no brand GUC is known (discovering WHICH connector to re-pull). Under
--   brain_app with FORCE RLS and no GUC set, a bare SELECT on connector_instance
--   returns 0 rows (fail-closed: current_setting returns NULL → uuid cast → FALSE).
--   Per durable rule system-job-force-rls-enumeration, a SECURITY DEFINER fn
--   owned by the migration superuser 'brain' bypasses FORCE RLS for this
--   dispatch-only enumeration step. Returns only (connector_instance_id, brand_id,
--   shop_domain, secret_ref) — no tenant data content.
--
-- (2) resolve_connector_by_shop_domain(p_shop_domain text):
--   Webhook brand resolution (D-4). The webhook handler receives an HMAC-validated
--   request. After HMAC passes, it resolves the brand from the shop_domain via
--   this fn. Under brain_app, connector_instance has FORCE RLS and no GUC is set
--   at webhook-receive time (no brand known yet — that's what we're resolving).
--   A bare SELECT returns 0 rows. This fn bypasses FORCE RLS to do the lookup
--   and returns dispatch-only cols: (connector_instance_id, brand_id, shop_domain,
--   secret_ref). The caller sets the brand GUC from the returned brand_id BEFORE
--   any tenant-scoped write. No connector found → 401, no write.
--
-- BOTH FNS:
--   - Owner: superuser 'brain' (migration owner) — SECURITY DEFINER runs as 'brain'
--   - SET search_path = public — prevents search_path hijack (SECURITY DEFINER attack)
--   - STABLE — correct (no writes; same inputs → same output within txn)
--   - LANGUAGE sql — least privilege (no PL/pgSQL process exception swallowing)
--   - GRANT EXECUTE TO brain_app — brain_app connection pool calls both fns
--   - Dispatch-only return cols — no tenant data content beyond identifiers
--   - Migration-time assertions: prosecdef=true, search_path=public, EXECUTE granted
--
-- ADDITIVE ONLY (I-E02): CREATE OR REPLACE FUNCTION. No table changes. 0025 untouched.
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS list_connectors_for_repull();
--   DROP FUNCTION IF EXISTS resolve_connector_by_shop_domain(text);
-- ============================================================================

-- ── (1) list_connectors_for_repull() — D-7 re-pull enumeration ───────────────

CREATE OR REPLACE FUNCTION list_connectors_for_repull()
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    shop_domain            text,
    secret_ref             text
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT
    ci.id             AS connector_instance_id,
    ci.brand_id,
    ci.shop_domain,
    ci.secret_ref
  FROM connector_instance ci
  WHERE ci.provider = 'shopify'
    AND ci.status   = 'connected'
  ORDER BY ci.created_at ASC
$$;

GRANT EXECUTE ON FUNCTION list_connectors_for_repull() TO brain_app;

-- ── Migration-time assertion (1a): fn is SECURITY DEFINER ────────────────────
DO $$
DECLARE
  fn_secdef  TEXT;
  fn_config  TEXT;
BEGIN
  SELECT
    p.prosecdef::text,
    array_to_string(p.proconfig, ', ')
  INTO fn_secdef, fn_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_connectors_for_repull'
    AND n.nspname = 'public';

  IF fn_secdef IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SEC-LV-0026 GUARD: list_connectors_for_repull() must be SECURITY DEFINER '
      '(prosecdef=true). Got: %', fn_secdef;
  END IF;

  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'SEC-LV-0026 GUARD: list_connectors_for_repull() must have SET search_path=public. '
      'Got config: %', fn_config;
  END IF;
END
$$;

-- ── Migration-time assertion (1b): brain_app has EXECUTE ─────────────────────
DO $$
DECLARE
  has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege('brain_app', 'list_connectors_for_repull()', 'EXECUTE')
  INTO has_execute;

  IF NOT has_execute THEN
    RAISE EXCEPTION
      'SEC-LV-0026 GUARD: brain_app does not have EXECUTE on list_connectors_for_repull().';
  END IF;
END
$$;

-- ── Migration-time assertion (1c): fn exists (dispatch-only sanity) ───────────
DO $$
DECLARE
  fn_count INT;
BEGIN
  SELECT count(*)
  INTO fn_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_connectors_for_repull'
    AND n.nspname = 'public';

  IF fn_count = 0 THEN
    RAISE EXCEPTION
      'SEC-LV-0026 GUARD: list_connectors_for_repull() not found after creation.';
  END IF;
END
$$;

-- ── (2) resolve_connector_by_shop_domain(p_shop_domain text) — D-4 webhook ──

CREATE OR REPLACE FUNCTION resolve_connector_by_shop_domain(p_shop_domain text)
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    shop_domain            text,
    secret_ref             text
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT
    ci.id             AS connector_instance_id,
    ci.brand_id,
    ci.shop_domain,
    ci.secret_ref
  FROM connector_instance ci
  WHERE ci.shop_domain = p_shop_domain
    AND ci.provider   = 'shopify'
    AND ci.status     = 'connected'
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION resolve_connector_by_shop_domain(text) TO brain_app;

-- ── Migration-time assertion (2a): fn is SECURITY DEFINER ────────────────────
DO $$
DECLARE
  fn_secdef  TEXT;
  fn_config  TEXT;
BEGIN
  SELECT
    p.prosecdef::text,
    array_to_string(p.proconfig, ', ')
  INTO fn_secdef, fn_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'resolve_connector_by_shop_domain'
    AND n.nspname = 'public';

  IF fn_secdef IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SEC-LV-0026 GUARD: resolve_connector_by_shop_domain() must be SECURITY DEFINER '
      '(prosecdef=true). Got: %', fn_secdef;
  END IF;

  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'SEC-LV-0026 GUARD: resolve_connector_by_shop_domain() must have SET search_path=public. '
      'Got config: %', fn_config;
  END IF;
END
$$;

-- ── Migration-time assertion (2b): brain_app has EXECUTE ─────────────────────
DO $$
DECLARE
  has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege('brain_app', 'resolve_connector_by_shop_domain(text)', 'EXECUTE')
  INTO has_execute;

  IF NOT has_execute THEN
    RAISE EXCEPTION
      'SEC-LV-0026 GUARD: brain_app does not have EXECUTE on resolve_connector_by_shop_domain(text).';
  END IF;
END
$$;

-- ── Migration-time assertion (2c): fn exists (dispatch-only sanity) ───────────
DO $$
DECLARE
  fn_count INT;
BEGIN
  SELECT count(*)
  INTO fn_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'resolve_connector_by_shop_domain'
    AND n.nspname = 'public';

  IF fn_count = 0 THEN
    RAISE EXCEPTION
      'SEC-LV-0026 GUARD: resolve_connector_by_shop_domain() not found after creation.';
  END IF;
END
$$;
