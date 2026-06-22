-- 0071_reference_tables_currency_timezone.sql
--
-- DB-AUDIT M4 — de-hardcode the brand currency/timezone enums. They were CHECK constraints locked to
-- INR/AED/SAR and 3 timezones, so onboarding a new region meant a migration + an ACCESS EXCLUSIVE
-- table rewrite. Replace the CHECKs with reference tables + FKs: a new currency/region is now a single
-- INSERT into the reference table (no migration, no lock). Existing values are seeded, so current
-- behaviour is preserved exactly (no new currency is silently enabled).

-- ── Reference tables (global, not tenant-scoped — reference data, no RLS) ─────────────────────────
CREATE TABLE IF NOT EXISTS tenancy.ref_currency (
  code               char(3)  PRIMARY KEY,           -- ISO-4217 alpha
  display_name       text     NOT NULL,
  minor_unit_digits  smallint NOT NULL DEFAULT 2,    -- money is stored as minor units everywhere
  is_active          boolean  NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS tenancy.ref_timezone (
  name        text    PRIMARY KEY,                   -- IANA tz name
  is_active   boolean NOT NULL DEFAULT true
);

-- Seed the currently-supported set (behaviour-preserving — the FK below admits exactly these today).
INSERT INTO tenancy.ref_currency (code, display_name, minor_unit_digits) VALUES
  ('INR', 'Indian Rupee', 2),
  ('AED', 'UAE Dirham', 2),
  ('SAR', 'Saudi Riyal', 2)
ON CONFLICT (code) DO NOTHING;

INSERT INTO tenancy.ref_timezone (name) VALUES
  ('Asia/Kolkata'), ('Asia/Dubai'), ('Asia/Riyadh')
ON CONFLICT (name) DO NOTHING;

-- brain_app reads the reference tables (e.g. to render a region/currency picker). FK enforcement
-- itself is a system operation and needs no grant; this is for app SELECTs.
GRANT SELECT ON tenancy.ref_currency, tenancy.ref_timezone TO brain_app;

-- ── Swap the hardcoded CHECKs for FKs ─────────────────────────────────────────────────────────────
ALTER TABLE tenancy.brand DROP CONSTRAINT IF EXISTS brand_currency_code_check;
ALTER TABLE tenancy.brand DROP CONSTRAINT IF EXISTS brand_timezone_check;

ALTER TABLE tenancy.brand
  ADD CONSTRAINT brand_currency_code_fkey FOREIGN KEY (currency_code) REFERENCES tenancy.ref_currency (code);
ALTER TABLE tenancy.brand
  ADD CONSTRAINT brand_timezone_fkey FOREIGN KEY (timezone) REFERENCES tenancy.ref_timezone (name);

-- ── Guards ────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('brand_currency_code_check','brand_timezone_check')) THEN
    RAISE EXCEPTION '0071 VIOLATION: hardcoded enum CHECKs must be dropped';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='brand_currency_code_fkey') THEN
    RAISE EXCEPTION '0071 VIOLATION: brand.currency_code FK to ref_currency missing';
  END IF;
END $$;
