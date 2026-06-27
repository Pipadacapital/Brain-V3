-- 0115_shred_subject_keyring_fn.sql
--
-- Adds the SECURITY DEFINER shred_subject_keyring(brand_id, brain_id) function that the
-- crypto-shred erasure orchestrator calls to deactivate a subject's envelope DEK (step 1
-- of the DPDP/PDPL ordered sequence). brain_app is SELECT-only on tenancy.subject_keyring
-- (0114 Assertion-1); this function runs as the owner ('brain') and bypasses FORCE RLS so
-- the app path can shred without elevated credentials.
--
-- IDEMPOTENT: the UPDATE is conditional on is_active=TRUE — replaying the erasure event
-- after the DEK is already inactive is a safe no-op (returns FALSE, no error).
--
-- RETURNS: TRUE when a row was found and deactivated; FALSE when is_active was already
-- FALSE (replay-safe) or the row does not exist (subject not provisioned = nothing to shred).
--
-- ADDITIVE. No existing objects are modified.
-- Rollback: DROP FUNCTION IF EXISTS shred_subject_keyring(uuid, uuid);

CREATE OR REPLACE FUNCTION shred_subject_keyring(p_brand_id uuid, p_brain_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, tenancy
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE tenancy.subject_keyring
  SET    is_active  = FALSE,
         updated_at = NOW()
  WHERE  brand_id  = p_brand_id
    AND  brain_id  = p_brain_id
    AND  is_active = TRUE;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION shred_subject_keyring(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shred_subject_keyring(uuid, uuid) TO brain_app;

-- ── Post-condition guards ──────────────────────────────────────────────────────
DO $$
BEGIN
  -- shred_subject_keyring must be SECURITY DEFINER + search_path-pinned
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'shred_subject_keyring'
      AND p.prosecdef
      AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0115 failed: shred_subject_keyring must be SECURITY DEFINER + search_path-pinned';
  END IF;

  -- brain_app must have EXECUTE
  IF NOT has_function_privilege('brain_app', 'shred_subject_keyring(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0115 failed: brain_app lacks EXECUTE on shred_subject_keyring';
  END IF;
END $$;
