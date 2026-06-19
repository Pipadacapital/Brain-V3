-- ============================================================================
-- 0037_contact_pii_ciphertext.sql
-- feat-identity-pii-vault (P0-C slice 2) — Backend / Security
-- ============================================================================
--
-- The contact_pii vault shipped (0017) with a dev-only plaintext `pii_value` column
-- and a TODO to "use pii_ciphertext" in prod (audit ARC-4: no encryption at rest).
-- This adds the AES-256-GCM envelope columns so the vault stores CIPHERTEXT, not
-- plaintext. The per-brand DEK is the brand_keyring DEK (KMS-wrapped, 0001); only the
-- send_service read path (app.role GUC) ever decrypts, transiently, at send time.
--
-- Envelope (per row): AES-256-GCM(plaintext, DEK) → (ciphertext, iv[12B], auth_tag[16B]).
-- key_version pins which brand_keyring DEK version encrypted the row (rotation-safe decrypt).
--
-- ADDITIVE ONLY (I-E02): ALTER ... ADD COLUMN IF NOT EXISTS. `pii_value` is retained
-- (legacy/dev) but the application writes NULL there once this lands. Existing table-level
-- GRANT (SELECT, INSERT) on contact_pii already covers the new columns.

ALTER TABLE contact_pii ADD COLUMN IF NOT EXISTS pii_ciphertext BYTEA   NULL;
ALTER TABLE contact_pii ADD COLUMN IF NOT EXISTS pii_iv         BYTEA   NULL;
ALTER TABLE contact_pii ADD COLUMN IF NOT EXISTS pii_auth_tag   BYTEA   NULL;
ALTER TABLE contact_pii ADD COLUMN IF NOT EXISTS key_version    INTEGER NULL;

-- ── Post-migration assertion: the envelope columns exist with the expected types ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'contact_pii' AND column_name = 'pii_ciphertext' AND data_type = 'bytea'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'contact_pii' AND column_name = 'pii_iv' AND data_type = 'bytea'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'contact_pii' AND column_name = 'pii_auth_tag' AND data_type = 'bytea'
  ) THEN
    RAISE EXCEPTION 'PII-VAULT MIGRATION: contact_pii envelope columns (pii_ciphertext/pii_iv/pii_auth_tag BYTEA) are missing or wrong-typed.';
  END IF;

  -- The elevated RLS policy (brand_id + app.role='send_service') must still be in force.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'contact_pii' AND policyname = 'contact_pii_isolation'
  ) THEN
    RAISE EXCEPTION 'PII-VAULT MIGRATION: contact_pii_isolation policy missing — vault must stay RLS-protected.';
  END IF;
END
$$;
