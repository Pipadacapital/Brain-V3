-- 0066_phase_a_operational_schemas_identity_consent_pixel_dataplane.sql
--
-- RE-PLATFORM PHASE A — PG operational-schema split (slice 4 of 4: identity + consent + pixel + data_plane).
--
-- The plan named 7 illustrative operational schemas (0063–0065). Several operational domains in PG do
-- not map to those 7; leaving them flat in `public` would defeat the "PG clearly operational" goal. So
-- this slice extends the split with four more domain schemas and relocates the remaining domain tables:
--
--   identity   — the customer-identity-resolution state (PG side of the identity layer; Neo4j is the
--                graph store, this is the relational identity/merge/PII-vault state).
--   consent    — consent records + tombstones (privacy/compliance operational state).
--   pixel      — first-party pixel install + status.
--   data_plane — the ingest spool + the PG bronze_events landing (collector_spool owns a sequence that
--                rides along).
--
-- Only `pgmigrations` (the migration ledger), `dev_secret` (dev-only secret store), and `_rls_demo`
-- (an RLS test fixture) intentionally remain in `public`.
--
-- Because new schemas are introduced, this slice also (1) extends the role search_path to span them and
-- (2) re-widens every SECURITY DEFINER function carrying a pinned search_path to the full list, so any
-- function reading a relocated table (erase_customer, resolve_merge_review, customer_list_for_brand,
-- admin_unmerge_customer, resolve_brand_by_install_token, …) keeps resolving. Owner/security unchanged.
-- RLS/triggers/FKs/indexes/owned-sequences travel with each table; grants preserved. Reverse = SET SCHEMA public.

-- ── 1. New domain schemas + app-role grants ──
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS consent;
CREATE SCHEMA IF NOT EXISTS pixel;
CREATE SCHEMA IF NOT EXISTS data_plane;

GRANT USAGE ON SCHEMA identity, consent, pixel, data_plane TO brain_app;

DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['identity','consent','pixel','data_plane'] LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brain_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO brain_app', s);
  END LOOP;
END $$;

-- ── 2. Extend the role search_path to span every operational schema (public first) ──
ALTER ROLE brain_app SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config, identity, consent, pixel, data_plane;
ALTER ROLE brain     SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config, identity, consent, pixel, data_plane;

-- ── 3. Re-widen every SECURITY DEFINER function with a pinned search_path to the full list ──
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.proconfig IS NOT NULL
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config, identity, consent, pixel, data_plane',
      r.sig
    );
  END LOOP;
END $$;

-- ── 4. Relocate the remaining domain tables ──
-- identity
ALTER TABLE customer                  SET SCHEMA identity;
ALTER TABLE identity_link             SET SCHEMA identity;
ALTER TABLE identity_merge_event      SET SCHEMA identity;
ALTER TABLE brain_id_alias            SET SCHEMA identity;
ALTER TABLE merge_review_queue        SET SCHEMA identity;
ALTER TABLE contact_pii               SET SCHEMA identity;
ALTER TABLE shared_utility_identifier SET SCHEMA identity;
-- consent
ALTER TABLE consent_record   SET SCHEMA consent;
ALTER TABLE consent_tombstone SET SCHEMA consent;
-- pixel
ALTER TABLE pixel_installation SET SCHEMA pixel;
ALTER TABLE pixel_status       SET SCHEMA pixel;
-- data_plane (collector_spool owns a sequence that travels with it)
ALTER TABLE collector_spool SET SCHEMA data_plane;
ALTER TABLE bronze_events   SET SCHEMA data_plane;
