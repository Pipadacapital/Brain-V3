-- ============================================================================
-- 0028_resolve_brand_by_install_token.sql
-- feat-collection-foundation — Track A / R2 keystone: server-side tenant-key
-- derivation. SECURITY DEFINER fn resolve_brand_by_install_token(p_install_token).
-- ============================================================================
--
-- WHY A SECURITY DEFINER FN (mirrors 0026 resolve_connector_by_shop_domain):
--
--   The R2 fix derives the authoritative brand_id from the pixel install_token
--   that rides every collector event's properties bag (ADR-1). At the point of
--   derivation in ProcessEventUseCase (stream-worker, brain_app), NO brand GUC is
--   known yet — that is precisely what we are resolving. pixel_installation has
--   FORCE ROW LEVEL SECURITY (0007:38), so a bare SELECT under brain_app with no
--   GUC set returns 0 rows (fail-closed: current_setting('app.current_brand_id',
--   TRUE) → NULL → ::uuid → policy FALSE). This fn bypasses FORCE RLS for the
--   dispatch-only token→brand lookup and returns ONLY (brand_id) — no tenant data
--   content. The caller sets the brand GUC from the returned brand_id BEFORE any
--   tenant-scoped write. Token absent/unresolved → 0 rows → caller quarantines.
--
--   The install_token is a PUBLIC tracking identifier by design (0007:9,20), NOT
--   a secret. Authority is the SERVER-SIDE derivation (token→brand lookup +
--   mismatch-quarantine in ProcessEventUseCase), never token secrecy and never a
--   client-stamped brand_id (R2: the tenant key is never trusted from input).
--
-- THIS FN:
--   - Owner: superuser 'brain' (migration owner) — SECURITY DEFINER runs as 'brain'
--   - SET search_path = public — prevents search_path hijack (SECURITY DEFINER attack)
--   - STABLE — correct (no writes; same input → same output within txn)
--   - LANGUAGE sql — least privilege (no PL/pgSQL exception swallowing)
--   - GRANT EXECUTE TO brain_app — the stream-worker brain_app pool calls it
--   - Dispatch-only return col — (brand_id) only; no tenant data content
--   - Migration-time assertions: prosecdef=true, search_path=public, EXECUTE granted
--
-- ADDITIVE ONLY (I-E02): CREATE OR REPLACE FUNCTION. No table change. 0026/0007 untouched.
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS resolve_brand_by_install_token(uuid);
-- ============================================================================

-- ── resolve_brand_by_install_token(p_install_token uuid) — R2 tenant-key derive ──

CREATE OR REPLACE FUNCTION resolve_brand_by_install_token(p_install_token uuid)
  RETURNS TABLE(
    brand_id uuid
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT
    pi.brand_id
  FROM pixel_installation pi
  WHERE pi.install_token = p_install_token
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION resolve_brand_by_install_token(uuid) TO brain_app;

-- ── Migration-time assertion (a): fn is SECURITY DEFINER + search_path=public ───
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
  WHERE p.proname = 'resolve_brand_by_install_token'
    AND n.nspname = 'public';

  IF fn_secdef IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SEC-0028 GUARD: resolve_brand_by_install_token() must be SECURITY DEFINER '
      '(prosecdef=true). Got: %', fn_secdef;
  END IF;

  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'SEC-0028 GUARD: resolve_brand_by_install_token() must have SET search_path=public. '
      'Got config: %', fn_config;
  END IF;
END
$$;

-- ── Migration-time assertion (b): brain_app has EXECUTE ────────────────────────
DO $$
DECLARE
  has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege('brain_app', 'resolve_brand_by_install_token(uuid)', 'EXECUTE')
  INTO has_execute;

  IF NOT has_execute THEN
    RAISE EXCEPTION
      'SEC-0028 GUARD: brain_app does not have EXECUTE on resolve_brand_by_install_token(uuid).';
  END IF;
END
$$;

-- ── Migration-time assertion (c): fn exists (dispatch-only sanity) ─────────────
DO $$
DECLARE
  fn_count INT;
BEGIN
  SELECT count(*)
  INTO fn_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'resolve_brand_by_install_token'
    AND n.nspname = 'public';

  IF fn_count = 0 THEN
    RAISE EXCEPTION
      'SEC-0028 GUARD: resolve_brand_by_install_token() not found after creation.';
  END IF;
END
$$;
