-- 0062_connector_provider_dehardcode.sql
--
-- SCALABILITY (re-platform Phase A): de-hardcode the connector provider list.
--
-- PROBLEM: `connector_instance.provider` carried a static `CHECK (provider IN (...))` that had to be
-- DROP+RECREATEd in a NEW MIGRATION for EVERY connector added — already done 8 times (0006, 0021,
-- 0027, 0029, 0030, 0058, 0059, 0060). That makes onboarding the next 20+ apps a migration-per-app
-- chore and is the connector-scalability anti-pattern.
--
-- RESOLUTION: drop the DB-level CHECK entirely. Provider validity is ALREADY enforced authoritatively
-- in application code at the single connect chokepoint (apps/core/src/main.ts POST /api/v1/connectors):
--   getDefinition(type)  → unknown provider ⇒ 400 (never reaches the DB)
--   isConnectable(def)   → coming_soon      ⇒ 422
-- against CONNECTOR_CATALOG (registry.ts), which ADR-CM-1 designates as the SINGLE SOURCE OF TRUTH for
-- the catalog ("a static TypeScript const, NOT a DB table"). The CHECK was redundant defense-in-depth
-- that duplicated the catalog in SQL. With it gone, adding a connector = a registry.ts row + handler —
-- NO migration. The UNIQUE (brand_id, provider) key and the FK-less TEXT column are unchanged.
--
-- (Data note: dev/test data is disposable; this is a forward, additive constraint-drop — safe to apply
-- on a fresh or existing DB. Reverse = re-add the CHECK with the then-current provider set.)

ALTER TABLE connector_instance
  DROP CONSTRAINT IF EXISTS connector_instance_provider_check;

-- Document the new contract at the column level (provider validity lives in the app connect-gate).
COMMENT ON COLUMN connector_instance.provider IS
  'Connector provider id (e.g. shopify, razorpay, ...). Validity is enforced in the app connect-gate '
  'against CONNECTOR_CATALOG (registry.ts, ADR-CM-1 SoT) — intentionally NOT a DB CHECK/enum, so a new '
  'connector is a catalog row + handler, never a migration. UNIQUE per (brand_id, provider).';
