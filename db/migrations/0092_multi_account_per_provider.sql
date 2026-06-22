-- ============================================================================
-- 0092_multi_account_per_provider.sql
-- feat/universal-connector-platform — Data Engineer
-- Gap B: multi-account per provider
-- ============================================================================
--
-- PROBLEM: UNIQUE(brand_id, provider) blocks a brand from connecting two Shopify
--   stores, two Meta ad accounts, or two Google Ads accounts under the same brand.
--
-- SOLUTION (additive-then-cutover, I-E02):
--   (A) Add account_key TEXT NOT NULL DEFAULT '__default__'.
--       Backfill all existing rows to '__default__' (sentinel for single-account
--       connectors — still unique under the NEW constraint).
--   (B) Drop the old UNIQUE(brand_id, provider) constraint.
--       Add UNIQUE(brand_id, provider, account_key) — now two rows of the same
--       provider can coexist when account_key differs.
--   (C) The repository UPSERT changes from ON CONFLICT (brand_id, provider) to
--       ON CONFLICT (brand_id, provider, account_key) — see PgConnectorInstanceRepository.
--   (D) Migration-time assertions.
--
-- NOTE: The existing SECURITY DEFINER enumeration fns (per-provider + generic 0091)
--   already return all connected rows per-provider — no fn change needed. The UPSERT
--   constraint flip is the key behavioural change.
--
-- ROLLBACK:
--   -- 1. Drop new constraint
--   ALTER TABLE connector_instance DROP CONSTRAINT IF EXISTS connector_instance_brand_provider_account_unique;
--   -- 2. Remove duplicate account_key rows (manual — impossible if multi-account rows already exist)
--   -- 3. Re-add the old constraint
--   ALTER TABLE connector_instance
--     ADD CONSTRAINT connector_instance_brand_provider_unique UNIQUE (brand_id, provider);
--   -- 4. Drop column
--   ALTER TABLE connector_instance DROP COLUMN IF EXISTS account_key;
-- ============================================================================

-- ── (A) Add account_key column ─────────────────────────────────────────────────
-- DEFAULT '__default__' ensures all new rows without an explicit key get the sentinel.
-- NOT NULL is safe here because the DEFAULT applies on INSERT; existing rows get the
-- DEFAULT via the UPDATE backfill below.

ALTER TABLE connector_instance
  ADD COLUMN IF NOT EXISTS account_key TEXT NOT NULL DEFAULT '__default__';

-- ── (A) Backfill existing rows ─────────────────────────────────────────────────
-- All pre-existing rows are single-account; use the sentinel '__default__'.
-- Idempotent: the DEFAULT already sets '__default__' on new rows; this UPDATE is
-- a no-op for rows inserted AFTER this migration runs (they already have the default).

UPDATE connector_instance
SET account_key = '__default__'
WHERE account_key IS DISTINCT FROM '__default__';

-- ── (B) Constraint swap ─────────────────────────────────────────────────────────
-- Drop the old UNIQUE(brand_id, provider) that prevented multi-account.
ALTER TABLE connector_instance
  DROP CONSTRAINT IF EXISTS connector_instance_brand_provider_unique;

-- Add UNIQUE(brand_id, provider, account_key).
-- Two Shopify stores → same brand_id + 'shopify' but different account_key.
-- Re-connect of the same single account → (brand, provider, '__default__') conflicts → UPSERT updates.
ALTER TABLE connector_instance
  ADD CONSTRAINT connector_instance_brand_provider_account_unique
    UNIQUE (brand_id, provider, account_key);

-- ── (D) Migration-time assertions ─────────────────────────────────────────────

-- (D-1) account_key column exists and has NOT NULL constraint
DO $$
DECLARE
  col_nullable TEXT;
BEGIN
  SELECT is_nullable
  INTO col_nullable
  FROM information_schema.columns
  WHERE table_name  = 'connector_instance'
    AND column_name = 'account_key';

  IF col_nullable IS NULL THEN
    RAISE EXCEPTION 'SEC-0092a GUARD: connector_instance.account_key column not found.';
  END IF;
  IF col_nullable <> 'NO' THEN
    RAISE EXCEPTION 'SEC-0092a GUARD: connector_instance.account_key must be NOT NULL. Got: %', col_nullable;
  END IF;
END
$$;

-- (D-2) No NULL account_key rows remain
DO $$
DECLARE
  null_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM connector_instance
  WHERE account_key IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'SEC-0092b GUARD: % connector_instance rows have NULL account_key after backfill.', null_count;
  END IF;
END
$$;

-- (D-3) Old unique constraint is gone
DO $$
DECLARE
  old_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'connector_instance_brand_provider_unique'
      AND contype = 'u'
  ) INTO old_exists;

  IF old_exists THEN
    RAISE EXCEPTION 'SEC-0092c GUARD: Old UNIQUE(brand_id, provider) constraint still exists — drop failed.';
  END IF;
END
$$;

-- (D-4) New unique constraint exists
DO $$
DECLARE
  new_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'connector_instance_brand_provider_account_unique'
      AND contype = 'u'
  ) INTO new_exists;

  IF NOT new_exists THEN
    RAISE EXCEPTION 'SEC-0092d GUARD: UNIQUE(brand_id, provider, account_key) constraint not found.';
  END IF;
END
$$;

-- (D-5) All existing rows have '__default__' account_key (backfill completeness)
DO $$
DECLARE
  non_default_count BIGINT;
BEGIN
  -- At migration time every row should be '__default__' since no app code writes other keys yet.
  SELECT COUNT(*) INTO non_default_count
  FROM connector_instance
  WHERE account_key <> '__default__';

  -- Not a hard failure — warn only (after this migration, the app may write non-default keys).
  IF non_default_count > 0 THEN
    RAISE NOTICE 'SEC-0092e INFO: % connector_instance rows have a non-default account_key (expected 0 at migration time, OK if test rows exist).', non_default_count;
  END IF;
END
$$;
