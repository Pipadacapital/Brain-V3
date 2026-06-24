-- 0100_erase_contact_pii_for_customer.sql
--
-- MEDALLION REALIGNMENT (Epic 3 / ADR-0004): identity moved to the Neo4j SoR; the GDPR/DPDP erase now
-- tombstones the identifier edges + marks the customer 'erased' in Neo4j. The raw-PII vault contact_pii
-- STAYS in PostgreSQL (encrypted, elevated RLS) — so the privileged hard-delete needs a focused
-- SECURITY DEFINER function (brain_app holds only SELECT/INSERT on contact_pii, never DELETE). This
-- replaces the contact_pii-deletion responsibility of the old erase_customer() fn (dropped with the PG
-- identity tables); the identity_link tombstone + customer 'erased' marking are now Neo4j graph ops.
--
-- Scoped to (brand_id, brain_id); returns the number of vault rows deleted. SECURITY DEFINER so it can
-- DELETE despite the brain_app GRANT; pins search_path; brand_id is the caller's session brand.

CREATE OR REPLACE FUNCTION erase_contact_pii_for_customer(p_brand_id UUID, p_brain_id UUID)
  RETURNS INTEGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, identity
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM contact_pii WHERE brand_id = p_brand_id AND brain_id = p_brain_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION erase_contact_pii_for_customer(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_contact_pii_for_customer(uuid, uuid) TO brain_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'erase_contact_pii_for_customer') THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0100): erase_contact_pii_for_customer() not found.';
  END IF;
END
$$;
