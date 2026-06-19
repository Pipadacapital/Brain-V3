-- ============================================================================
-- 0049_find_invite_for_acceptance.sql
-- feat-tenancy-runtime-brain-app (A1.4) — auth primitive: invite-by-token lookup
-- ============================================================================
--
-- Accepting an invite resolves it BY TOKEN before the workspace/brand is known — but `invite` is
-- FORCE-RLS scoped (invite_org_level = app.current_workspace_id, invite_brand_level = app.current_brand_id).
-- Under the non-superuser brain_app role the token lookup would fail closed (NIL GUCs → 0 rows), and the
-- GUCs cannot be set first because the invite token IS the only credential the accepter holds. Same shape
-- as find_session_for_rotation (0048): the bearer of a valid pending invite token is authorized to resolve
-- it. SECURITY DEFINER controlled bypass; the caller then sets the workspace/brand GUC from the resolved
-- invite and performs the membership INSERT + invite UPDATE under brain_app + those GUCs.
--
-- ADDITIVE ONLY (I-E02). ROLLBACK: DROP FUNCTION find_invite_for_acceptance(text);

CREATE OR REPLACE FUNCTION find_invite_for_acceptance(p_token_hash TEXT)
  RETURNS SETOF invite
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT * FROM invite
   WHERE token_hash = p_token_hash AND status = 'pending' AND expires_at > NOW();
$$;

GRANT EXECUTE ON FUNCTION find_invite_for_acceptance(text) TO brain_app;

-- ── Assertions ─────────────────────────────────────────────────────────────────
DO $$
DECLARE v_secdef boolean; v_cfg text;
BEGIN
  SELECT p.prosecdef, array_to_string(p.proconfig, ',')
    INTO v_secdef, v_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'find_invite_for_acceptance';
  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0049): find_invite_for_acceptance() not found.';
  END IF;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'AUTH GUARD (0049): find_invite_for_acceptance() must be SECURITY DEFINER.';
  END IF;
  IF v_cfg IS NULL OR v_cfg NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'AUTH GUARD (0049): find_invite_for_acceptance() must pin search_path=public.';
  END IF;
END
$$;
