-- 0109_brand_identity_salt.sql
--
-- RUNTIME per-brand identity-salt provisioning (prod onboarding unblock).
--
-- THE PROBLEM
-- In production resolveSaltHex (packages/identity-core) has NO deterministic fallback — it reads the
-- per-brand salt from an IDENTITY_SALT_<brand> ENV var injected at DEPLOY time. A brand created at
-- RUNTIME (every real onboarding) therefore has no salt → the D-2 guard HARD-CRASHES every PII hash
-- (identity bridge, ingest mapper, consent/can_contact, webhooks). The PII vault has the same gap:
-- a new brand has no tenancy.brand_keyring row → KmsVaultKeyProvider fails closed. Salts/keyrings
-- were only ever seeded for PRE-EXISTING brands by tools/seed/prod-local-aws-bootstrap.sh.
--
-- THE FIX (this migration = the storage + access seam)
-- Store the per-brand identity salt the SAME way the PII-vault DEK is stored (tenancy.brand_keyring):
-- a KMS-WRAPPED 32-byte secret in a SELECT-only, FORCE-RLS table. Brand creation generates + KMS-wraps
-- a random salt AND a random DEK and writes BOTH atomically via the SECURITY DEFINER provisioner here;
-- the salt resolver reads the salt back via a SECURITY DEFINER reader (idiomatic resolve_*-fn pattern,
-- so no app.current_brand_id GUC dance and provably one-brand-scoped). brain_app stays SELECT-only on
-- the table — writes go ONLY through provision_brand_crypto (mirrors the 0001 "provisioning job, never
-- the app" intent for brand_keyring).
--
-- IDEMPOTENT: provision_brand_crypto UPSERTs ON CONFLICT DO NOTHING — a retry NEVER rotates an
-- existing salt/DEK (rotating a salt would silently break hash continuity; rotating a DEK would make
-- every vaulted contact_pii row undecryptable). Provisioning is therefore safe to call on every
-- brand-create retry.
--
-- ADDITIVE. Rollback: DROP FUNCTION get_brand_identity_salt(uuid),
--   provision_brand_crypto(uuid,text,text,text); DROP TABLE tenancy.brand_identity_salt;

-- ── The table (mirrors tenancy.brand_keyring) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenancy.brand_identity_salt (
  -- One row per brand; brand_id IS the PK.
  brand_id         UUID        PRIMARY KEY,
  -- AWS KMS key ID (ARN or alias) of the CMK used to wrap this brand's salt.
  kms_key_id       TEXT        NOT NULL,
  -- The base64-encoded KMS-wrapped (ciphertext) 32-byte salt blob.
  -- NEVER store the plaintext salt here or anywhere in the DB.
  wrapped_salt_b64 TEXT        NOT NULL,
  -- KMS key rotation version — bumped on each rotation event (parity with brand_keyring).
  key_version      INTEGER     NOT NULL DEFAULT 1,
  -- Whether the salt is active. Deactivated on DPDP erasure (crypto-shred), parity with brand_keyring.
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- App role: SELECT only (parity with brand_keyring, 0001). INSERT/UPDATE go via provision_brand_crypto.
REVOKE ALL ON tenancy.brand_identity_salt FROM brain_app;
GRANT SELECT ON tenancy.brand_identity_salt TO brain_app;

-- Strict brand-scoped isolation on read AND write (mirror tenancy.brand_keyring / 0067). Defence in
-- depth: a compromised brain_app cannot read another brand's wrapped salt. The SECURITY DEFINER
-- reader below is the sanctioned access path (owner bypasses RLS, returns ONLY the requested brand).
ALTER TABLE tenancy.brand_identity_salt ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.brand_identity_salt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS brand_identity_salt_isolation ON tenancy.brand_identity_salt;
CREATE POLICY brand_identity_salt_isolation ON tenancy.brand_identity_salt
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)
  WITH CHECK (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- ── Provisioner: write keyring + salt atomically, never rotate existing (idempotent) ────────────
-- Owned by 'brain'; SECURITY DEFINER so it can write the SELECT-only, FORCE-RLS tables. search_path
-- pinned to the schemas it touches. ON CONFLICT DO NOTHING => safe on every brand-create retry.
CREATE OR REPLACE FUNCTION provision_brand_crypto(
  p_brand_id          uuid,
  p_kms_key_id        text,
  p_wrapped_dek_b64   text,
  p_wrapped_salt_b64  text
)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, tenancy
AS $$
  INSERT INTO tenancy.brand_keyring (brand_id, kms_key_id, wrapped_dek_b64, key_version, is_active)
  VALUES (p_brand_id, p_kms_key_id, p_wrapped_dek_b64, 1, true)
  ON CONFLICT (brand_id) DO NOTHING;

  INSERT INTO tenancy.brand_identity_salt (brand_id, kms_key_id, wrapped_salt_b64, key_version, is_active)
  VALUES (p_brand_id, p_kms_key_id, p_wrapped_salt_b64, 1, true)
  ON CONFLICT (brand_id) DO NOTHING;
$$;

GRANT EXECUTE ON FUNCTION provision_brand_crypto(uuid, text, text, text) TO brain_app;

-- ── Reader: resolve ONE brand's salt material (SECURITY DEFINER, no GUC needed) ──────────────────
-- Mirrors the resolve_*-connector pattern: owner-run, returns only the requested brand's row, so the
-- app reads salt without setting app.current_brand_id and with zero cross-brand exposure.
CREATE OR REPLACE FUNCTION get_brand_identity_salt(p_brand_id uuid)
  RETURNS TABLE(
    kms_key_id        text,
    wrapped_salt_b64  text,
    key_version       integer,
    is_active         boolean
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public, tenancy
AS $$
  SELECT s.kms_key_id, s.wrapped_salt_b64, s.key_version, s.is_active
  FROM tenancy.brand_identity_salt s
  WHERE s.brand_id = p_brand_id
$$;

GRANT EXECUTE ON FUNCTION get_brand_identity_salt(uuid) TO brain_app;

-- ── Reader: resolve ONE brand's KEYRING (vault DEK) material — same SECURITY DEFINER pattern ─────
-- tenancy.brand_keyring is FORCE-RLS (0067) scoped by app.current_brand_id. KmsVaultKeyProvider reads
-- it from the raw (non-GUC) pool, so a direct `FROM brand_keyring` returns ZERO rows under FORCE RLS
-- (predicate brand_id = NULL) → the vault DEK lookup fails for every brand. Reading via this owner-run
-- reader (returns only the requested brand) removes the GUC dependency, exactly like the salt reader.
CREATE OR REPLACE FUNCTION get_brand_keyring(p_brand_id uuid)
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
  SELECT k.kms_key_id, k.wrapped_dek_b64, k.key_version, k.is_active
  FROM tenancy.brand_keyring k
  WHERE k.brand_id = p_brand_id
$$;

GRANT EXECUTE ON FUNCTION get_brand_keyring(uuid) TO brain_app;

-- ── Post-condition guards (mirror the SEC-* pattern) ────────────────────────────────────────────
DO $$
BEGIN
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'tenancy.brand_identity_salt'::regclass) THEN
    RAISE EXCEPTION '0109 failed: tenancy.brand_identity_salt must FORCE ROW LEVEL SECURITY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenancy' AND tablename='brand_identity_salt') THEN
    RAISE EXCEPTION '0109 failed: tenancy.brand_identity_salt missing RLS policy';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.proname = 'provision_brand_crypto' AND p.prosecdef AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0109 failed: provision_brand_crypto must be SECURITY DEFINER + search_path-pinned';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.proname = 'get_brand_identity_salt' AND p.prosecdef AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0109 failed: get_brand_identity_salt must be SECURITY DEFINER + search_path-pinned';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.proname = 'get_brand_keyring' AND p.prosecdef AND p.proconfig IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0109 failed: get_brand_keyring must be SECURITY DEFINER + search_path-pinned';
  END IF;
  IF NOT has_function_privilege('brain_app', 'provision_brand_crypto(uuid,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0109 failed: brain_app lacks EXECUTE on provision_brand_crypto';
  END IF;
  IF NOT has_function_privilege('brain_app', 'get_brand_identity_salt(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0109 failed: brain_app lacks EXECUTE on get_brand_identity_salt';
  END IF;
END $$;
