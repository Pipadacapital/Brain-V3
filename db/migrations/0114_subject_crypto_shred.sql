-- 0114_subject_crypto_shred.sql
--
-- Per-subject (brain_id-level) envelope encryption + Right-to-be-Forgotten (RTBF)
-- audit log — the subject-granularity complement to the brand-level keyring (0001)
-- and brand identity salt (0109).
--
-- WHY PER-SUBJECT KEYING
-- brand_keyring (0001) provides one DEK per brand. Crypto-shredding a BRAND means
-- deactivating that one DEK and every vaulted row becomes unreadable. But DPDP / GDPR
-- require SUBJECT-level erasure: one customer requests deletion, only that subject's
-- PII must be rendered unrecoverable — the rest of the brand's vault stays intact.
-- Per-subject wrapped DEKs in tenancy.subject_keyring make this possible:
--   • Provision: generate a subject DEK, KMS-wrap it, store it here.
--   • Encrypt: the vault row carries subject_key_version (new column on contact_pii) to
--     signal which keyring (subject DEK at that version) encrypted it.
--   • Crypto-shred: set is_active = FALSE here — the subject DEK is logically destroyed.
--     The ciphertext in contact_pii remains but is permanently unreadable. This is the
--     PRIMARY erasure mechanism. erase_contact_pii_for_customer() (0100) is the belt-
--     and-suspenders hard-delete; keep it — both mechanisms are complementary.
--   • Legacy rows: contact_pii rows with subject_key_version IS NULL were encrypted with
--     the brand DEK (key_version column). The app falls back to brand_keyring for those.
--
-- CRYPTO-SHRED PROCEDURE (operational — not automated here)
--   1. Receive RTBF request for (brand_id, brain_id).
--   2. INSERT into identity.pii_erasure_log (brand_id, brain_id, requested_at).
--   3. Admin/ops job: UPDATE tenancy.subject_keyring SET is_active = FALSE
--      WHERE brand_id = ? AND brain_id = ? (superuser or a future shred SECURITY DEFINER).
--   4. Run erasure_raw_delete.py for the Iceberg Bronze layer.
--   5. Call erase_contact_pii_for_customer(brand_id, brain_id) as belt-and-suspenders.
--   6. UPDATE identity.pii_erasure_log SET vault_shredded = TRUE, completed_at = NOW()
--      WHERE brand_id = ? AND brain_id = ?.
-- Note: brain_app is SELECT-only on subject_keyring; step 3 must be a privileged path.
--
-- ADDITIVE. New objects only — brand_keyring untouched, 0100 untouched.
-- Rollback:
--   DROP TABLE identity.pii_erasure_log;
--   DROP TABLE tenancy.subject_keyring;
--   ALTER TABLE identity.contact_pii DROP COLUMN IF EXISTS subject_key_version;
--   DROP FUNCTION IF EXISTS get_subject_keyring(uuid,uuid);
--   DROP FUNCTION IF EXISTS provision_subject_crypto(uuid,uuid,text,text);

-- ── 1. Per-subject envelope-key table (mirrors tenancy.brand_keyring) ───────────────────────────
--
-- One row per (brand_id, brain_id). brand_id-first on every key/index for tenant partitioning.
-- brain_app is SELECT-only — writes go exclusively through provision_subject_crypto
-- (mirrors the "provisioning job, never the app" intent of 0001/0109 for brand_keyring).
CREATE TABLE IF NOT EXISTS tenancy.subject_keyring (
  -- Composite PK: brand_id FIRST (tenant isolation), then brain_id.
  brand_id         UUID        NOT NULL,
  brain_id         UUID        NOT NULL,
  -- AWS KMS key ID (ARN or alias) of the CMK used to wrap this subject's DEK.
  kms_key_id       TEXT        NOT NULL,
  -- Base64-encoded KMS-wrapped (ciphertext) DEK blob. NEVER store the plaintext DEK here.
  wrapped_dek_b64  TEXT        NOT NULL,
  -- Key-rotation version. Bumped on each rotation event; parity with brand_keyring.
  key_version      INTEGER     NOT NULL DEFAULT 1,
  -- Crypto-shred gate: FALSE = subject DEK logically destroyed; vault rows unreadable.
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, brain_id)
);

-- App role: SELECT only (mirrors brand_keyring, 0001). INSERT/UPDATE via provision_subject_crypto.
REVOKE ALL ON tenancy.subject_keyring FROM brain_app;
GRANT SELECT ON tenancy.subject_keyring TO brain_app;

-- FORCE RLS: defence-in-depth brand isolation. Even a compromised brain_app session cannot
-- scan another brand's subject keys. The SECURITY DEFINER readers below are the only
-- sanctioned access path (owner bypasses RLS; returns exactly the requested subject).
ALTER TABLE tenancy.subject_keyring ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.subject_keyring FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subject_keyring_isolation ON tenancy.subject_keyring;
CREATE POLICY subject_keyring_isolation ON tenancy.subject_keyring
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)
  WITH CHECK (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- ── 2. RTBF erasure audit log ────────────────────────────────────────────────────────────────────
--
-- One row per (brand_id, brain_id) erasure request. brand_id-first (tenant isolation).
-- Lifecycle: INSERT on request receipt → UPDATE vault_shredded/completed_at on fulfillment.
-- brain_app holds SELECT + INSERT + UPDATE (no DELETE — the log is append-and-update-only;
-- completed rows must never be removed for compliance audit purposes).
CREATE TABLE IF NOT EXISTS identity.pii_erasure_log (
  brand_id           UUID        NOT NULL,
  brain_id           UUID        NOT NULL,
  -- Wall-clock time the RTBF request was received.
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- TRUE once the subject_keyring row has is_active = FALSE (primary crypto-shred mechanism).
  vault_shredded     BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Optional surrogate brain_id minted post-erasure (pseudonymised analytics continuity).
  surrogate_brain_id UUID        NULL,
  -- TRUE once a Conversions API / platform erasure request has been dispatched.
  capi_requested     BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Set when all erasure steps have completed (NULL = in-progress).
  completed_at       TIMESTAMPTZ NULL,
  PRIMARY KEY (brand_id, brain_id)
);

REVOKE ALL ON identity.pii_erasure_log FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON identity.pii_erasure_log TO brain_app;

-- FORCE RLS: brand_id-scoped so brain_app cannot read or write another brand's erasure log.
ALTER TABLE identity.pii_erasure_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.pii_erasure_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pii_erasure_log_isolation ON identity.pii_erasure_log;
CREATE POLICY pii_erasure_log_isolation ON identity.pii_erasure_log
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)
  WITH CHECK (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- ── 3. Subject-level key-version column on the PII vault ────────────────────────────────────────
--
-- Disambiguates decryption path at read time:
--   subject_key_version IS NOT NULL → decrypt with subject_keyring (this migration)
--   subject_key_version IS NULL     → legacy row; decrypt with brand_keyring (0001/0037 key_version)
-- The existing key_version column (0037) is retained as the brand-level version; this new
-- column is the subject-level peer. Both can coexist on the same row (NULL/NOT NULL pattern).
ALTER TABLE identity.contact_pii
  ADD COLUMN IF NOT EXISTS subject_key_version INTEGER NULL;

-- ── 4. Provisioner: write ONE subject's keyring row — idempotent, never rotates ─────────────────
--
-- Mirrors provision_brand_crypto (0109) exactly:
--   • Owned by 'brain'; SECURITY DEFINER so it can INSERT into the SELECT-only FORCE-RLS table.
--   • search_path pinned to tenancy (the only schema it writes to).
--   • ON CONFLICT DO NOTHING: safe on every subject-create / brand-onboarding retry.
--     A retry NEVER rotates an existing subject DEK — rotating a DEK would make every
--     vaulted contact_pii row for that subject permanently undecryptable.
CREATE OR REPLACE FUNCTION provision_subject_crypto(
  p_brand_id        uuid,
  p_brain_id        uuid,
  p_kms_key_id      text,
  p_wrapped_dek_b64 text
)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, tenancy
AS $$
  INSERT INTO tenancy.subject_keyring (
    brand_id, brain_id, kms_key_id, wrapped_dek_b64, key_version, is_active
  )
  VALUES (p_brand_id, p_brain_id, p_kms_key_id, p_wrapped_dek_b64, 1, true)
  ON CONFLICT (brand_id, brain_id) DO NOTHING;
$$;

GRANT EXECUTE ON FUNCTION provision_subject_crypto(uuid, uuid, text, text) TO brain_app;

-- ── 5. Reader: resolve ONE subject's keyring material (SECURITY DEFINER, no GUC dance) ──────────
--
-- Mirrors get_brand_keyring (0109) exactly:
--   • Owner-run; returns only the requested (brand_id, brain_id) row.
--   • STABLE + SECURITY DEFINER: bypasses FORCE RLS, scoped strictly to the two args.
--   • No app.current_brand_id GUC required; caller supplies brand_id explicitly.
--     This is intentional — the vault key provider runs on a pool connection without a GUC
--     and a direct SELECT on subject_keyring returns 0 rows under FORCE RLS.
CREATE OR REPLACE FUNCTION get_subject_keyring(
  p_brand_id uuid,
  p_brain_id uuid
)
  RETURNS TABLE(
    kms_key_id       text,
    wrapped_dek_b64  text,
    key_version      integer,
    is_active        boolean
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public, tenancy
AS $$
  SELECT s.kms_key_id, s.wrapped_dek_b64, s.key_version, s.is_active
  FROM tenancy.subject_keyring s
  WHERE s.brand_id = p_brand_id
    AND s.brain_id = p_brain_id
$$;

GRANT EXECUTE ON FUNCTION get_subject_keyring(uuid, uuid) TO brain_app;

-- ── 6. Post-condition guards (mirrors 0109 SEC-* pattern) ────────────────────────────────────────
DO $$
BEGIN
  -- subject_keyring must be FORCE RLS
  IF NOT (
    SELECT relforcerowsecurity
    FROM pg_class
    WHERE oid = 'tenancy.subject_keyring'::regclass
  ) THEN
    RAISE EXCEPTION '0114 failed: tenancy.subject_keyring must FORCE ROW LEVEL SECURITY';
  END IF;

  -- subject_keyring isolation policy must exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'tenancy' AND tablename = 'subject_keyring'
  ) THEN
    RAISE EXCEPTION '0114 failed: tenancy.subject_keyring missing RLS isolation policy';
  END IF;

  -- pii_erasure_log must be FORCE RLS
  IF NOT (
    SELECT relforcerowsecurity
    FROM pg_class
    WHERE oid = 'identity.pii_erasure_log'::regclass
  ) THEN
    RAISE EXCEPTION '0114 failed: identity.pii_erasure_log must FORCE ROW LEVEL SECURITY';
  END IF;

  -- pii_erasure_log isolation policy must exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'identity' AND tablename = 'pii_erasure_log'
  ) THEN
    RAISE EXCEPTION '0114 failed: identity.pii_erasure_log missing RLS isolation policy';
  END IF;

  -- contact_pii.subject_key_version column must exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'identity'
      AND table_name   = 'contact_pii'
      AND column_name  = 'subject_key_version'
      AND data_type    = 'integer'
  ) THEN
    RAISE EXCEPTION '0114 failed: identity.contact_pii.subject_key_version (integer) missing';
  END IF;

  -- provision_subject_crypto must be SECURITY DEFINER + search_path-pinned
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'provision_subject_crypto'
      AND p.prosecdef
      AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0114 failed: provision_subject_crypto must be SECURITY DEFINER + search_path-pinned';
  END IF;

  -- get_subject_keyring must be SECURITY DEFINER + search_path-pinned
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'get_subject_keyring'
      AND p.prosecdef
      AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0114 failed: get_subject_keyring must be SECURITY DEFINER + search_path-pinned';
  END IF;

  -- brain_app must have EXECUTE on both functions
  IF NOT has_function_privilege('brain_app', 'provision_subject_crypto(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0114 failed: brain_app lacks EXECUTE on provision_subject_crypto';
  END IF;

  IF NOT has_function_privilege('brain_app', 'get_subject_keyring(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0114 failed: brain_app lacks EXECUTE on get_subject_keyring';
  END IF;
END $$;
