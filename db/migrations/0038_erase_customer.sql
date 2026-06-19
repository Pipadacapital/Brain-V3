-- ============================================================================
-- 0038_erase_customer.sql
-- feat-identity-erasure (P0-C) — DPDP right-to-deletion (per-subject)
-- ============================================================================
--
-- A DPDP / GDPR subject-deletion for ONE customer: hard-delete the raw PII vault rows,
-- tombstone the identity links so the hashed identifiers no longer resolve, mark the
-- customer 'erased', and record the action in identity_audit (counts only — no raw PII).
--
-- WHY A SECURITY DEFINER FUNCTION: brain_app holds only SELECT/INSERT on contact_pii and
-- identity_link (no DELETE / no UPDATE — append-only by grant). Erasure is the ONE legitimate
-- privileged mutation, so it runs inside this owner-defined function (scoped strictly to the
-- passed brand_id + brain_id) rather than by broadening brain_app's grants. SET search_path
-- = public pins resolution (no search_path hijack). brand_id is ALWAYS the caller's session
-- brand — a brain_id from another brand simply matches 0 rows (no cross-tenant erase).
--
-- ADDITIVE ONLY (I-E02): CREATE OR REPLACE FUNCTION.
-- ROLLBACK: DROP FUNCTION IF EXISTS erase_customer(uuid, uuid);

CREATE OR REPLACE FUNCTION erase_customer(p_brand_id uuid, p_brain_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_exists  boolean;
  v_pii     int;
  v_links   int;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM customer WHERE brand_id = p_brand_id AND brain_id = p_brain_id
  ) INTO v_exists;

  IF NOT v_exists THEN
    RETURN jsonb_build_object('erased', false, 'contact_pii_deleted', 0, 'links_tombstoned', 0);
  END IF;

  -- 1. Hard-delete the raw PII vault rows for this customer.
  DELETE FROM contact_pii WHERE brand_id = p_brand_id AND brain_id = p_brain_id;
  GET DIAGNOSTICS v_pii = ROW_COUNT;

  -- 2. Tombstone the identity links (hashed identifiers no longer resolve).
  UPDATE identity_link SET is_active = FALSE
   WHERE brand_id = p_brand_id AND brain_id = p_brain_id AND is_active = TRUE;
  GET DIAGNOSTICS v_links = ROW_COUNT;

  -- 3. Mark the customer erased.
  UPDATE customer SET lifecycle_state = 'erased'
   WHERE brand_id = p_brand_id AND brain_id = p_brain_id;

  -- 4. Audit (hashed refs / counts only — never raw PII).
  INSERT INTO identity_audit (brand_id, brain_id, action, detail)
  VALUES (
    p_brand_id, p_brain_id, 'erase',
    jsonb_build_object('contact_pii_deleted', v_pii, 'links_tombstoned', v_links)
  );

  RETURN jsonb_build_object('erased', true, 'contact_pii_deleted', v_pii, 'links_tombstoned', v_links);
END;
$$;

GRANT EXECUTE ON FUNCTION erase_customer(uuid, uuid) TO brain_app;

-- ── Migration-time assertion: fn is SECURITY DEFINER with pinned search_path ──
DO $$
DECLARE
  is_secdef boolean;
  fn_config text;
BEGIN
  SELECT p.prosecdef, array_to_string(p.proconfig, ',')
    INTO is_secdef, fn_config
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'erase_customer';

  IF is_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'ERASURE GUARD: erase_customer() must be SECURITY DEFINER (prosecdef=true).';
  END IF;
  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'ERASURE GUARD: erase_customer() must pin SET search_path = public.';
  END IF;
END
$$;
