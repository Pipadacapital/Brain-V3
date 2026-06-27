/**
 * @brain/pii-vault — per-brand AND per-subject DEK providers for the contact_pii vault (P0-C).
 *
 * Shared by apps/core (the vault read path / MatchPiiPort) AND apps/stream-worker (the
 * ingestion write path), so BOTH encrypt/decrypt with the SAME key for a brand/subject:
 *   - dev   : deterministic per-brand or per-subject DEK derived from the IDs (zero-seeding).
 *   - prod  : DEK unwrapped from brand_keyring or subject_keyring via AWS KMS.
 *
 * ## Crypto-shred levels
 * - Brand-level: brand_keyring.is_active=FALSE → every row for that brand becomes permanently
 *   unreadable (existing behaviour, I-S05).
 * - Subject-level (new, Task B): tenancy.subject_keyring.is_active=FALSE → rows whose
 *   subject_key_version is set are permanently unreadable for that subject (DPDP per-subject
 *   erasure). Rows with NULL subject_key_version were encrypted with the brand DEK and fall
 *   back to the brand keyring.
 *
 * The AES-256-GCM cipher lives in @brain/identity-core (encryptPii/decryptPii); this
 * package only provides the KEY. The plaintext DEK lives in memory only (I-S09).
 *
 * ## getDek() return value
 * Returns { dek, keyVersion, level } where level='subject' means the per-subject DEK served the
 * request and the caller SHOULD stamp subject_key_version on the contact_pii row. level='brand'
 * means the legacy brand-level DEK was used (subject row absent or subjectId not supplied).
 */
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { deriveDevVaultDek, deriveDevSubjectVaultDek, resolveDevSaltHex } from '@brain/identity-core';

// ── VaultKeyProvider interface ────────────────────────────────────────────────

/**
 * Supplies the 32-byte DEK for encrypting/decrypting a PII row.
 *
 * Call signature:
 *   getDek(brandId)                              → brand DEK  (level='brand')
 *   getDek(brandId, { keyVersion: n })           → brand DEK  (level='brand', keyVersion hint kept for
 *                                                   future version-indexed lookup; currently advisory)
 *   getDek(brandId, { subjectId })               → subject DEK if provisioned (level='subject'),
 *                                                   brand fallback if subject row absent (level='brand')
 *   getDek(brandId, { subjectId, keyVersion: n}) → same as above, with version hint
 *
 * The brand-only form getDek(brandId) is fully preserved — it compiles and behaves
 * byte-identically with the pre-Task-B behaviour.
 */
export interface VaultKeyProvider {
  getDek(
    brandId: string,
    opts?: { subjectId?: string; keyVersion?: number | null },
  ): Promise<{ dek: Buffer; keyVersion: number; level: 'subject' | 'brand' }>;

  /**
   * Drop any in-process cached DEK. invalidate(brandId) clears the brand-level entry;
   * invalidate(brandId, subjectId) clears the per-subject entry. Called from the erasure path
   * (SEC M-1) so a shredded subject's DEK cannot be served from cache after key-deny.
   */
  invalidate(brandId: string, subjectId?: string): void;
}

// ── Dev-only provider ─────────────────────────────────────────────────────────

/** Dev-only deterministic DEK provider. NEVER used in production. */
export class DevVaultKeyProvider implements VaultKeyProvider {
  async getDek(
    brandId: string,
    opts?: { subjectId?: string; keyVersion?: number | null },
  ): Promise<{ dek: Buffer; keyVersion: number; level: 'subject' | 'brand' }> {
    if (opts?.subjectId) {
      return {
        dek: deriveDevSubjectVaultDek(brandId, opts.subjectId),
        keyVersion: 1,
        level: 'subject',
      };
    }
    return { dek: deriveDevVaultDek(brandId), keyVersion: 1, level: 'brand' };
  }

  /** Dev DEKs are derived deterministically (not cached); no-op so it satisfies the interface. */
  invalidate(): void {
    /* no-op — DevVaultKeyProvider derives keys deterministically, holds no cache. */
  }
}

// ── Default-closed guard ──────────────────────────────────────────────────────

/**
 * Default-closed provider. Throws rather than encrypt/decrypt with a non-KMS key — used as a
 * guard where a real KMS provider must be wired before the vault may operate.
 */
export class UnwiredProdVaultKeyProvider implements VaultKeyProvider {
  async getDek(): Promise<{ dek: Buffer; keyVersion: number; level: 'subject' | 'brand' }> {
    throw new Error(
      '[pii-vault] production KMS key provider is not wired — refusing to encrypt/decrypt with a non-KMS key (default-closed).',
    );
  }

  /** No cache to clear (this provider never serves a key); no-op so it satisfies the interface. */
  invalidate(): void {
    /* no-op — UnwiredProdVaultKeyProvider holds no key cache. */
  }
}

// ── AWS KMS provider ──────────────────────────────────────────────────────────

/** Minimal KMS decrypt seam — satisfied by AwsKmsDecryptAdapter; mockable in tests. */
export interface KmsDecryptPort {
  decrypt(args: { keyId: string; ciphertextBlob: Uint8Array }): Promise<Buffer>;
}

/** Real AWS KMS adapter. Credentials come from IRSA (no static keys), like AwsSecretsProvider. */
export class AwsKmsDecryptAdapter implements KmsDecryptPort {
  // Lazily constructed so importing this module never requires the SDK at load time.
  private clientPromise: Promise<{
    send: (cmd: unknown) => Promise<{ Plaintext?: Uint8Array }>;
  }> | null = null;

  constructor(private readonly region: string = process.env['AWS_REGION'] ?? 'ap-south-1') {}

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = import('@aws-sdk/client-kms').then(
        ({ KMSClient }) => new KMSClient({ region: this.region }) as never,
      );
    }
    return this.clientPromise;
  }

  async decrypt(args: { keyId: string; ciphertextBlob: Uint8Array }): Promise<Buffer> {
    const { DecryptCommand } = await import('@aws-sdk/client-kms');
    const client = await this.client();
    const out = await client.send(
      new DecryptCommand({ KeyId: args.keyId, CiphertextBlob: args.ciphertextBlob }),
    );
    if (!out.Plaintext) {
      throw new Error('[pii-vault] KMS Decrypt returned no plaintext');
    }
    return Buffer.from(out.Plaintext);
  }
}

/**
 * Production VaultKeyProvider. Extends the existing per-brand path with an opt-in per-subject
 * path for DPDP per-subject crypto-shred (Task B).
 *
 * ## Brand path (getDek(brandId) — unchanged behaviour)
 * Reads get_brand_keyring(uuid) via the SECURITY DEFINER reader (0109), KMS-Decrypts the
 * wrapped_dek_b64 → 32-byte DEK, caches per brand, fails CLOSED on is_active=FALSE.
 *
 * ## Subject path (getDek(brandId, { subjectId }))
 * Reads get_subject_keyring(brand_id, brain_id), KMS-Decrypts the subject-specific DEK, caches
 * per (brand_id, brain_id). Fails CLOSED on is_active=FALSE (per-subject crypto-shred). If the
 * subject row is ABSENT (legacy contact encrypted with the brand DEK), silently falls back to
 * the brand path so that existing rows remain readable after the migration.
 *
 * ## Crypto-shred / DPDP erasure (I-S05)
 * - Brand shred: getDek(...) on a brand_keyring where is_active=FALSE → throws.
 * - Subject shred: getDek(..., { subjectId }) on a subject_keyring where is_active=FALSE → throws.
 * Call invalidate(brandId) or invalidate(brandId, subjectId) from the erasure path so any cached
 * DEK is dropped immediately.
 */
export class KmsVaultKeyProvider implements VaultKeyProvider {
  /** Cache key: brandId alone → brand DEK. */
  private readonly brandCache = new Map<string, { dek: Buffer; keyVersion: number }>();
  /** Cache key: `${brandId}:${subjectId}` → subject DEK. */
  private readonly subjectCache = new Map<string, { dek: Buffer; keyVersion: number }>();

  constructor(
    private readonly pool: Pool,
    private readonly kms: KmsDecryptPort,
  ) {}

  async getDek(
    brandId: string,
    opts?: { subjectId?: string; keyVersion?: number | null },
  ): Promise<{ dek: Buffer; keyVersion: number; level: 'subject' | 'brand' }> {
    if (opts?.subjectId) {
      return this.getSubjectDekWithFallback(brandId, opts.subjectId);
    }
    return this.getBrandDek(brandId);
  }

  private async getSubjectDekWithFallback(
    brandId: string,
    subjectId: string,
  ): Promise<{ dek: Buffer; keyVersion: number; level: 'subject' | 'brand' }> {
    const cacheKey = `${brandId}:${subjectId}`;
    const cached = this.subjectCache.get(cacheKey);
    if (cached) return { ...cached, level: 'subject' };

    // Read via the SECURITY DEFINER reader get_subject_keyring(uuid, uuid) — mirrors
    // get_brand_keyring; owner-run, no GUC dependency, one-row-scoped per (brand, subject).
    const r = await this.pool.query<{
      kms_key_id: string;
      wrapped_dek_b64: string;
      key_version: number;
      is_active: boolean;
    }>('SELECT kms_key_id, wrapped_dek_b64, key_version, is_active FROM get_subject_keyring($1, $2)', [
      brandId,
      subjectId,
    ]);
    const row = r.rows[0];

    if (!row) {
      // Subject keyring row absent → legacy row encrypted with brand DEK; fall back transparently.
      return this.getBrandDek(brandId);
    }

    if (!row.is_active) {
      throw new Error(
        `[pii-vault] subject_keyring for brand=${brandId} subject=${subjectId} is inactive (per-subject crypto-shred)`,
      );
    }

    const dek = await this.kms.decrypt({
      keyId: row.kms_key_id,
      ciphertextBlob: Buffer.from(row.wrapped_dek_b64, 'base64'),
    });
    if (dek.length !== 32) {
      throw new Error(`[pii-vault] unwrapped subject DEK is ${dek.length} bytes; expected 32 (AES-256)`);
    }

    const result = { dek, keyVersion: row.key_version };
    this.subjectCache.set(cacheKey, result);
    return { ...result, level: 'subject' };
  }

  private async getBrandDek(
    brandId: string,
  ): Promise<{ dek: Buffer; keyVersion: number; level: 'brand' }> {
    const cached = this.brandCache.get(brandId);
    if (cached) return { ...cached, level: 'brand' };

    // Read via the SECURITY DEFINER reader get_brand_keyring(uuid) (0109), NOT a direct
    // `FROM brand_keyring`: that table is FORCE-RLS (0067) scoped by app.current_brand_id, which
    // is NOT set on the raw pool this provider runs on → a direct read returns zero rows in prod.
    // The owner-run reader returns only the requested brand's row, removing the GUC dependency.
    const r = await this.pool.query<{
      kms_key_id: string;
      wrapped_dek_b64: string;
      key_version: number;
      is_active: boolean;
    }>('SELECT kms_key_id, wrapped_dek_b64, key_version, is_active FROM get_brand_keyring($1)', [
      brandId,
    ]);
    const row = r.rows[0];
    if (!row) {
      throw new Error(`[pii-vault] no brand_keyring row for brand ${brandId}`);
    }
    if (!row.is_active) {
      throw new Error(`[pii-vault] brand_keyring for ${brandId} is inactive (crypto-shred / erased)`);
    }

    const dek = await this.kms.decrypt({
      keyId: row.kms_key_id,
      ciphertextBlob: Buffer.from(row.wrapped_dek_b64, 'base64'),
    });
    if (dek.length !== 32) {
      throw new Error(`[pii-vault] unwrapped DEK is ${dek.length} bytes; expected 32 (AES-256)`);
    }

    const result = { dek, keyVersion: row.key_version };
    this.brandCache.set(brandId, result);
    return { ...result, level: 'brand' };
  }

  /**
   * Drop the cached DEK for a brand or a specific subject (call from the erasure path so
   * crypto-shred takes effect immediately without waiting for a cache miss).
   *   invalidate(brandId)            → clears the brand-level cache entry
   *   invalidate(brandId, subjectId) → clears the subject-level cache entry
   */
  invalidate(brandId: string, subjectId?: string): void {
    if (subjectId) {
      this.subjectCache.delete(`${brandId}:${subjectId}`);
    } else {
      this.brandCache.delete(brandId);
    }
  }
}

// ── KMS encrypt seam (for PROVISIONING — wrap a freshly-generated salt/DEK) ─────
// The decrypt adapter above is read-only; provisioning a new brand or subject needs to WRAP
// a plaintext secret.

/** Minimal KMS encrypt seam — satisfied by AwsKmsEncryptAdapter; mockable in tests. */
export interface KmsEncryptPort {
  /** KMS-Encrypt `plaintext` under `keyId`; returns the ciphertext blob (store base64). */
  encrypt(args: { keyId: string; plaintext: Uint8Array }): Promise<Buffer>;
}

/** Real AWS KMS encrypt adapter. Mirrors AwsKmsDecryptAdapter (IRSA creds, lazy SDK import). */
export class AwsKmsEncryptAdapter implements KmsEncryptPort {
  private clientPromise: Promise<{
    send: (cmd: unknown) => Promise<{ CiphertextBlob?: Uint8Array }>;
  }> | null = null;

  constructor(private readonly region: string = process.env['AWS_REGION'] ?? 'ap-south-1') {}

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = import('@aws-sdk/client-kms').then(
        ({ KMSClient }) => new KMSClient({ region: this.region }) as never,
      );
    }
    return this.clientPromise;
  }

  async encrypt(args: { keyId: string; plaintext: Uint8Array }): Promise<Buffer> {
    const { EncryptCommand } = await import('@aws-sdk/client-kms');
    const client = await this.client();
    const out = await client.send(
      new EncryptCommand({ KeyId: args.keyId, Plaintext: args.plaintext }),
    );
    if (!out.CiphertextBlob) {
      throw new Error('[pii-vault] KMS Encrypt returned no ciphertext');
    }
    return Buffer.from(out.CiphertextBlob);
  }
}

// ── Per-brand identity SALT providers (parity with the DEK providers above) ─────
// The identity salt is, like the vault DEK, a per-brand 32-byte secret. In dev it is derived
// deterministically (zero-seeding); in prod it is KMS-wrapped at brand creation, stored in
// tenancy.brand_identity_salt (0109), and unwrapped here. The 64-hex form is what hashIdentifier wants.

/** Supplies the per-brand identity salt as a 64-hex string. Dev derives it; prod unwraps via KMS. */
export interface BrandSaltSource {
  saltHexForBrand(brandId: string): Promise<string>;
  /** Drop the cached salt for a brand (erasure / rotation). */
  invalidate(brandId: string): void;
}

/** Dev-only deterministic per-brand salt provider. NEVER used in production. */
export class DevBrandSaltProvider implements BrandSaltSource {
  async saltHexForBrand(brandId: string): Promise<string> {
    return resolveDevSaltHex(brandId);
  }
  invalidate(): void {
    /* no-op: dev salt is derived, never cached */
  }
}

/**
 * Production salt provider. Resolves the per-brand salt from tenancy.brand_identity_salt via the
 * SECURITY DEFINER reader get_brand_identity_salt(uuid) (0109) — so no app.current_brand_id GUC is
 * needed and the row is provably one-brand-scoped — then KMS-Decrypts the wrapped 32-byte salt and
 * returns it as 64-hex. Per-brand cache (TTL), fails CLOSED (the D-2 guard) on missing/inactive/
 * wrong-length salt. Mirrors KmsVaultKeyProvider.
 */
export class KmsBrandSaltProvider implements BrandSaltSource {
  private readonly cache = new Map<string, { saltHex: string; at: number }>();
  private readonly ttlMs: number;

  constructor(
    private readonly pool: Pool,
    private readonly kms: KmsDecryptPort,
    ttlMs = 5 * 60 * 1000,
  ) {
    this.ttlMs = ttlMs;
  }

  async saltHexForBrand(brandId: string): Promise<string> {
    const cached = this.cache.get(brandId);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.saltHex;

    const r = await this.pool.query<{
      kms_key_id: string;
      wrapped_salt_b64: string;
      key_version: number;
      is_active: boolean;
    }>('SELECT kms_key_id, wrapped_salt_b64, key_version, is_active FROM get_brand_identity_salt($1)', [
      brandId,
    ]);
    const row = r.rows[0];
    if (!row) {
      throw new Error(
        `[brand-salt] no brand_identity_salt row for brand ${brandId} — brand crypto not provisioned (D-2)`,
      );
    }
    if (!row.is_active) {
      throw new Error(`[brand-salt] salt for ${brandId} is inactive (crypto-shred / erased)`);
    }
    const salt = await this.kms.decrypt({
      keyId: row.kms_key_id,
      ciphertextBlob: Buffer.from(row.wrapped_salt_b64, 'base64'),
    });
    if (salt.length !== 32) {
      throw new Error(`[brand-salt] unwrapped salt is ${salt.length} bytes; expected 32`);
    }
    const saltHex = salt.toString('hex'); // 64 hex chars — what hashIdentifier expects
    this.cache.set(brandId, { saltHex, at: Date.now() });
    return saltHex;
  }

  invalidate(brandId: string): void {
    this.cache.delete(brandId);
  }
}

/**
 * Provisions a brand's crypto at creation time: generates a random 32-byte salt AND a random 32-byte
 * DEK, KMS-wraps both under the configured CMK, and writes tenancy.brand_keyring + brand_identity_salt
 * atomically via the SECURITY DEFINER provision_brand_crypto(uuid,text,text,text) (0109). IDEMPOTENT:
 * the SQL UPSERTs ON CONFLICT DO NOTHING, so a retry never rotates an existing brand's salt/DEK
 * (which would break hash continuity / make vaulted PII undecryptable). Dev does NOT use this — dev
 * salt/DEK are derived deterministically, so brand creation in dev needs no provisioning.
 */
export class BrandCryptoProvisioner {
  constructor(
    private readonly pool: Pool,
    private readonly kms: KmsEncryptPort,
    private readonly kmsKeyId: string,
  ) {}

  async provision(brandId: string): Promise<void> {
    const salt = randomBytes(32);
    const dek = randomBytes(32);
    const [wrappedSalt, wrappedDek] = await Promise.all([
      this.kms.encrypt({ keyId: this.kmsKeyId, plaintext: salt }),
      this.kms.encrypt({ keyId: this.kmsKeyId, plaintext: dek }),
    ]);
    await this.pool.query('SELECT provision_brand_crypto($1, $2, $3, $4)', [
      brandId,
      this.kmsKeyId,
      wrappedDek.toString('base64'),
      wrappedSalt.toString('base64'),
    ]);
  }
}

/**
 * Provisions a subject's crypto at first-contact time: generates a random 32-byte DEK,
 * KMS-wraps it under the configured CMK, and writes tenancy.subject_keyring via the SECURITY
 * DEFINER provision_subject_crypto(p_brand_id, p_brain_id, kms_key_id, wrapped_dek_b64)
 * (target schema). IDEMPOTENT: the SQL UPSERTs ON CONFLICT DO NOTHING, so a retry never
 * rotates an existing subject's DEK (which would make previously-vaulted rows undecryptable).
 *
 * Dev does NOT use this — dev subject DEKs are derived deterministically from (brandId, subjectId)
 * via deriveDevSubjectVaultDek.
 *
 * Per-subject crypto-shred (DPDP erasure): set tenancy.subject_keyring.is_active=FALSE for the
 * subject row (and write to pii_erasure_log). KmsVaultKeyProvider.getDek() then fails closed on
 * that subject → all rows stamped with that subject_key_version become permanently unreadable.
 */
export class SubjectCryptoProvisioner {
  constructor(
    private readonly pool: Pool,
    private readonly kms: KmsEncryptPort,
    private readonly kmsKeyId: string,
  ) {}

  async provision(brandId: string, subjectId: string): Promise<void> {
    const dek = randomBytes(32);
    const wrappedDek = await this.kms.encrypt({ keyId: this.kmsKeyId, plaintext: dek });
    await this.pool.query('SELECT provision_subject_crypto($1, $2, $3, $4)', [
      brandId,
      subjectId,
      this.kmsKeyId,
      wrappedDek.toString('base64'),
    ]);
  }
}
