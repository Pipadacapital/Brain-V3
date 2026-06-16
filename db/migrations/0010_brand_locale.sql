-- ============================================================================
-- 0010_brand_locale.sql — Brand locale columns: currency_code, timezone, revenue_definition
-- ============================================================================
-- AC-4 / MA-08 / MA-11 / MA-12
--
-- ISOLATION NOTE (NN-1 / AC-4):
--   `brand` is already RLS-scoped to app.current_brand_id (two-arg fail-closed,
--   0004_brand.sql:37-39). New columns inherit that policy automatically.
--   A cross-brand SELECT returns 0 rows including these columns — no new policy needed.
--   Builder: extend the brand isolation-fuzz assertion to read currency_code and
--   confirm cross-brand returns nothing.
--
-- DEPLOY NOTE (MA-08): Run BEFORE deploying core. Backend mapRow is column-absent
--   defensive (?? default) so a migrate↔core ordering slip is non-fatal.
--
-- MONEY INVARIANT (I-S07): currency_code CHAR(3) paired with existing *_minor BIGINT
--   pattern. No float columns. These are config columns, not ledger amounts.
--
-- MA-12 (BINDING): revenue_definition CHECK = ('realized','delivered').
--   'placed' is EXCLUDED — no placed_revenue metric in METRICS.md (grep-confirmed).
--   MER is "never placed/gross" (METRICS.md:28). Add 'placed' only when
--   placed_revenue is added to METRICS.md in a future migration.
--
-- MA-12 Backfill: NOT NULL DEFAULT fills existing rows. No data migration needed.
-- ============================================================================

ALTER TABLE brand ADD COLUMN IF NOT EXISTS currency_code CHAR(3) NOT NULL DEFAULT 'INR'
  CHECK (currency_code IN ('INR','AED','SAR'));
-- I-S07: currency_code CHAR(3) paired with existing *_minor BIGINT ledger pattern.

ALTER TABLE brand ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'
  CHECK (timezone IN ('Asia/Kolkata','Asia/Dubai','Asia/Riyadh'));
-- Bounded allowlist (not dynamic Intl.* — avoids over-engineering, AC-4).

ALTER TABLE brand ADD COLUMN IF NOT EXISTS revenue_definition TEXT NOT NULL DEFAULT 'realized'
  CHECK (revenue_definition IN ('realized','delivered'));
-- MA-12: 'placed' EXCLUDED — no metric engine definition in METRICS.md.
-- Default 'realized' = correct for COD-India/GCC (METRICS.md:55).

-- Backfill: NOT NULL DEFAULT already fills existing brand rows (INR/Kolkata/realized).
-- PG14+: ADD COLUMN ... NOT NULL DEFAULT <const> is a catalog-only change, no table rewrite.

-- ============================================================================
-- MANUAL ROLLBACK PROCEDURE (SEC-AOF-M3 / deploy-runbook):
--
--   PRECONDITION: Only safe to roll back in the DEPLOY WINDOW before any brand
--   row has been updated with a non-default value (i.e. no brand has been saved
--   with currency_code != 'INR' or timezone != 'Asia/Kolkata' or
--   revenue_definition != 'realized'). After that window, these DROPs are
--   IRREVERSIBLE (data loss).
--
--   To rollback this migration manually:
--     ALTER TABLE brand DROP COLUMN IF EXISTS revenue_definition;
--     ALTER TABLE brand DROP COLUMN IF EXISTS timezone;
--     ALTER TABLE brand DROP COLUMN IF EXISTS currency_code;
--
--   Verify no non-default values exist before running:
--     SELECT COUNT(*) FROM brand
--       WHERE currency_code != 'INR'
--          OR timezone != 'Asia/Kolkata'
--          OR revenue_definition != 'realized';
--     -- If count > 0, rollback is destructive and must be approved by the on-call lead.
-- ============================================================================
