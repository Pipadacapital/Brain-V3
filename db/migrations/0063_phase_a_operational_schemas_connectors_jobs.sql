-- 0063_phase_a_operational_schemas_connectors_jobs.sql
--
-- RE-PLATFORM PHASE A — PG operational-schema split (slice 1 of N: connectors + jobs).
--
-- GOAL: make Postgres clearly "operational" by organizing the flat `public` schema into operational
-- domains (iam, tenancy, connectors, jobs, billing, audit, ai_config). This slice establishes the
-- foundation (the 7 schemas + grants + search_path) and moves the CONNECTOR-integration tables into
-- `connectors` and the async work queue into `jobs`. Later slices move the remaining domains.
--
-- STRATEGY (expand/contract, reversible): the app uses UNQUALIFIED table names everywhere and relies on
-- search_path resolution (no per-query schema). So instead of 54 compatibility views (which break
-- ON CONFLICT / RETURNING write paths), we:
--   1. create the operational schemas + grant the app role USAGE + default privileges,
--   2. widen the role search_path to span all operational schemas (public first) — every repo query and
--      function body keeps resolving with ZERO code changes,
--   3. ALTER TABLE ... SET SCHEMA (RLS policies, triggers, FKs, indexes, and owned sequences travel with
--      the table automatically; table/sequence grants are preserved),
--   4. re-pin the SECURITY DEFINER functions that pinned search_path=public so they resolve the moved
--      tables (and stay correct as later slices relocate more tables).
--
-- ADR-CM-1 note: the connector CATALOG stays a static registry.ts const (NOT a DB connector_registry
-- table) — the plan's registry-table item is intentionally satisfied by 0062 + the app connect-gate.
-- The connector TABLE renames (connector_instance→connectors etc.) are deferred (structural-first).
--
-- CUTOVER: new sessions inherit the widened search_path automatically; the running dev app must
-- reconnect (restart) to find the relocated tables. Reverse = SET SCHEMA public + reset search_path
-- (per the program's revert-the-PR reversibility).
-- Data note: dev/test data is disposable; this is an additive, forward reorganization.

-- ── 1. Foundation: the seven operational schemas (created once; later slices fill the rest) ──
CREATE SCHEMA IF NOT EXISTS iam;
CREATE SCHEMA IF NOT EXISTS tenancy;
CREATE SCHEMA IF NOT EXISTS connectors;
CREATE SCHEMA IF NOT EXISTS jobs;
CREATE SCHEMA IF NOT EXISTS billing;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS ai_config;

-- The app role needs USAGE on each schema to reach its objects (table-level grants are preserved on
-- SET SCHEMA, so no per-table re-grant is required for the moved tables).
GRANT USAGE ON SCHEMA iam, tenancy, connectors, jobs, billing, audit, ai_config TO brain_app;

-- Future tables/sequences created in these schemas (by the migration owner 'brain') auto-grant to the
-- app role, mirroring the existing per-migration grant pattern for `public`.
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['iam','tenancy','connectors','jobs','billing','audit','ai_config'] LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brain_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE brain IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO brain_app', s);
  END LOOP;
END $$;

-- ── 2. search_path: span the operational schemas (public first) so unqualified SQL keeps resolving ──
-- public stays first: pgmigrations + the not-yet-moved tables live there, and new unqualified CREATEs
-- default to public (later slices move them explicitly).
ALTER ROLE brain_app SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER ROLE brain     SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;

-- ── 3. Relocate the connector-integration tables → connectors; the async work queue → jobs ──
ALTER TABLE connector_instance            SET SCHEMA connectors;
ALTER TABLE connector_cursor              SET SCHEMA connectors;
ALTER TABLE connector_sync_status         SET SCHEMA connectors;
ALTER TABLE connector_journey_stitch_map  SET SCHEMA connectors;
ALTER TABLE connector_razorpay_order_map  SET SCHEMA connectors;
ALTER TABLE connector_webhook_raw_archive SET SCHEMA connectors;  -- owned id sequence moves with it
ALTER TABLE backfill_job                  SET SCHEMA jobs;

-- ── 4. Re-pin the SECURITY DEFINER system functions that read the relocated tables ──
-- These pinned search_path=public (the secure-definer hygiene pattern). Widen to the full operational
-- list (a fixed set of our own schemas — still injection-safe) so they resolve the moved tables now and
-- remain correct as later slices relocate more. Owner + security_definer + body unchanged.
ALTER FUNCTION claim_due_repull_connectors(integer, integer)            SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER FUNCTION list_ad_connectors_for_spend_repull()                    SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER FUNCTION list_connectors_for_repull()                             SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER FUNCTION list_gokwik_connectors_for_awb_repull()                  SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER FUNCTION list_queued_backfill_jobs()                              SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER FUNCTION list_razorpay_connectors_for_settlement_repull()         SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER FUNCTION list_shiprocket_connectors_for_repull()                  SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER FUNCTION list_shopflo_connectors()                                SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER FUNCTION list_woocommerce_connectors_for_repull()                 SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER FUNCTION resolve_connector_by_shop_domain(text)                   SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER FUNCTION resolve_razorpay_connector_by_account(text)             SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER FUNCTION resolve_shopflo_connector_by_merchant(text)             SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
ALTER FUNCTION resolve_woocommerce_connector_by_site(text)             SET search_path = public, iam, tenancy, connectors, jobs, billing, audit, ai_config;
