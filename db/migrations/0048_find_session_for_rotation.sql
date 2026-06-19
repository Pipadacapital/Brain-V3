-- ============================================================================
-- 0048_find_session_for_rotation.sql
-- feat-tenancy-runtime-brain-app (A1.3) — auth primitive: session-by-token lookup
-- ============================================================================
--
-- refresh-token rotation finds the session row BY TOKEN before the user is known — but user_session is
-- FORCE-RLS scoped by user_session_isolation (app_user_id = app.current_user_id). Under the non-superuser
-- brain_app role the lookup would fail closed (NIL user GUC → 0 rows), and the user GUC cannot be set
-- first because the token IS the only credential. This is an authentication primitive: the bearer of a
-- valid refresh token is authorized to resolve its own session.
--
-- find_session_for_rotation() is a SECURITY DEFINER lookup (same controlled-bypass pattern as
-- provision_workspace_and_brand / issue_invoice): it returns the matching session row LOCKED FOR UPDATE
-- (MA-03 — serializes concurrent rotations). The caller then sets app.current_user_id from the resolved
-- app_user_id and performs the revoke/insert under brain_app + the user GUC (those rows ARE then RLS-
-- scoped to the resolved user). No raw user_session read happens outside the user-GUC context.
--
-- ADDITIVE ONLY (I-E02). ROLLBACK: DROP FUNCTION find_session_for_rotation(text);

CREATE OR REPLACE FUNCTION find_session_for_rotation(p_refresh_token_hash TEXT)
  RETURNS SETOF user_session
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT * FROM user_session WHERE refresh_token_hash = p_refresh_token_hash FOR UPDATE;
$$;

GRANT EXECUTE ON FUNCTION find_session_for_rotation(text) TO brain_app;

-- ── Assertions ─────────────────────────────────────────────────────────────────
DO $$
DECLARE v_secdef boolean; v_cfg text;
BEGIN
  SELECT p.prosecdef, array_to_string(p.proconfig, ',')
    INTO v_secdef, v_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'find_session_for_rotation';
  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0048): find_session_for_rotation() not found.';
  END IF;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'AUTH GUARD (0048): find_session_for_rotation() must be SECURITY DEFINER.';
  END IF;
  IF v_cfg IS NULL OR v_cfg NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'AUTH GUARD (0048): find_session_for_rotation() must pin search_path=public.';
  END IF;
END
$$;
