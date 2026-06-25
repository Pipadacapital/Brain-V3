-- 0110_token_lookup_security_definer.sql
--
-- FIX: email verification + password reset are IMPOSSIBLE in production.
--
-- iam.email_verification and iam.password_reset are RLS-isolated by
-- `app_user_id = current_setting('app.current_user_id', TRUE)::uuid` (their *_isolation policies).
-- But the verify-email and reset-password lookups are PRE-AUTH: the user is not logged in, so no
-- app.current_user_id GUC is set when the token is presented. brain_app therefore sees ZERO rows
-- (predicate = `app_user_id = NULL`), and the endpoint returns "Invalid or expired token" for a
-- perfectly valid token. (Latent until now: in dev, registration auto-verifies, so this path was
-- never exercised; it only bites in NODE_ENV=production.)
--
-- The token IS the authorization: only someone holding the raw token can produce its sha256 hash
-- (preimage resistance), so a hash lookup needs no prior user context. These SECURITY DEFINER
-- readers run as the owner (bypass RLS) and return ONLY the single row whose token_hash matches and
-- which is still unused + unexpired — exactly the validity filter the repos applied. No enumeration
-- surface (you cannot list tokens; you can only confirm a hash you already possess). The subsequent
-- writes (markUsed / markEmailVerified / updatePasswordHash) run with app.current_user_id set to the
-- resolved app_user_id, so they stay RLS-enforced. Mirrors the get_brand_* SECURITY DEFINER pattern.
--
-- ADDITIVE. Rollback: DROP FUNCTION find_email_verification_by_hash(text),
--   find_password_reset_by_hash(text);

CREATE OR REPLACE FUNCTION find_email_verification_by_hash(p_token_hash text)
  RETURNS TABLE(
    id           uuid,
    app_user_id  uuid,
    token_hash   text,
    expires_at   timestamptz,
    used_at      timestamptz,
    created_at   timestamptz
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public, iam
AS $$
  SELECT e.id, e.app_user_id, e.token_hash, e.expires_at, e.used_at, e.created_at
  FROM iam.email_verification e
  WHERE e.token_hash = p_token_hash
    AND e.used_at IS NULL
    AND e.expires_at > NOW()
$$;

GRANT EXECUTE ON FUNCTION find_email_verification_by_hash(text) TO brain_app;

CREATE OR REPLACE FUNCTION find_password_reset_by_hash(p_token_hash text)
  RETURNS TABLE(
    id           uuid,
    app_user_id  uuid,
    token_hash   text,
    expires_at   timestamptz,
    used_at      timestamptz,
    created_at   timestamptz
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public, iam
AS $$
  SELECT r.id, r.app_user_id, r.token_hash, r.expires_at, r.used_at, r.created_at
  FROM iam.password_reset r
  WHERE r.token_hash = p_token_hash
    AND r.used_at IS NULL
    AND r.expires_at > NOW()
$$;

GRANT EXECUTE ON FUNCTION find_password_reset_by_hash(text) TO brain_app;

-- Post-condition guards (mirror the SEC-* pattern).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.proname = 'find_email_verification_by_hash' AND p.prosecdef AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0110 failed: find_email_verification_by_hash must be SECURITY DEFINER + search_path-pinned';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.proname = 'find_password_reset_by_hash' AND p.prosecdef AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0110 failed: find_password_reset_by_hash must be SECURITY DEFINER + search_path-pinned';
  END IF;
  IF NOT has_function_privilege('brain_app', 'find_email_verification_by_hash(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0110 failed: brain_app lacks EXECUTE on find_email_verification_by_hash';
  END IF;
  IF NOT has_function_privilege('brain_app', 'find_password_reset_by_hash(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0110 failed: brain_app lacks EXECUTE on find_password_reset_by_hash';
  END IF;
END $$;
