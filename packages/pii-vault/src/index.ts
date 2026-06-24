/**
 * @brain/pii-vault — per-brand DEK providers for the contact_pii vault (P0-C).
 *
 * Shared by apps/core (the vault read path / MatchPiiPort) AND apps/stream-worker (the
 * ingestion write path), so BOTH encrypt/decrypt with the SAME key for a brand:
 *   - dev   : a deterministic per-brand DEK derived from the brand_id (zero-seeding).
 *   - prod  : the per-brand DEK unwrapped from brand_keyring via AWS KMS (KmsVaultKeyProvider).
 *
 * The AES-256-GCM cipher itself lives in @brain/identity-core (encryptPii/decryptPii); this
 * package only provides the KEY. The plaintext DEK lives in memory only, never persisted (I-S09).
 */
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { deriveDevVaultDek, resolveDevSaltHex } from '@brain/identity-core';

/** Supplies the 32-byte per-brand DEK. Dev derives it; prod unwraps brand_keyring via KMS. */
export interface VaultKeyProvider {
  getDek(brandId: string, keyVersion?: number | null): Promise<{ dek: Buffer; keyVersion: number }>;
}

/** Dev-only deterministic per-brand DEK provider. NEVER used in production. */
export class DevVaultKeyProvider implements VaultKeyProvider {
  async getDek(brandId: string): Promise<{ dek: Buffer; keyVersion: number }> {
    return { dek: deriveDevVaultDek(brandId), keyVersion: 1 };
  }
}

/**
 * Default-closed provider. Throws rather than encrypt/decrypt with a non-KMS key — used as a
 * guard where a real KMS provider must be wired before the vault may operate.
 */
export class UnwiredProdVaultKeyProvider implements VaultKeyProvider {
  async getDek(): Promise<{ dek: Buffer; keyVersion: number }> {
    throw new Error(
      '[pii-vault] production KMS key provider is not wired — refusing to encrypt/decrypt with a non-KMS key (default-closed).',
    );
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
 * Production VaultKeyProvider. Unwraps the per-brand DEK from brand_keyring (0001) via AWS KMS.
 *
 * brand_keyring stores, per brand: kms_key_id (the CMK), wrapped_dek_b64 (the KMS-wrapped DEK),
 * key_version, is_active. We KMS-Decrypt the wrapped blob → the 32-byte plaintext DEK, held ONLY
 * in memory (I-S09). Per-brand cache + invalidate().
 *
 * Crypto-shred / DPDP erasure (I-S05): getDek() fails closed on is_active=FALSE (the key is
 * revoked → every vaulted row is permanently unreadable). Call invalidate(brandId) from the
 * erasure path so a cached DEK is dropped immediately.
 *
 * Takes a Pool (read brand_keyring) and a KmsDecryptPort (mockable for tests).
 */
export class KmsVaultKeyProvider implements VaultKeyProvider {
  private readonly cache = new Map<string, { dek: Buffer; keyVersion: number }>();

  constructor(
    private readonly pool: Pool,
    private readonly kms: KmsDecryptPort,
  ) {}

  async getDek(brandId: string): Promise<{ dek: Buffer; keyVersion: number }> {
    const cached = this.cache.get(brandId);
    if (cached) return cached;

    // Read via the SECURITY DEFINER reader get_brand_keyring(uuid) (0109), NOT a direct
    // `FROM brand_keyring`: that table is FORCE-RLS (0067) scoped by app.current_brand_id, which is
    // NOT set on the raw pool this provider runs on → a direct read returns zero rows in prod. The
    // owner-run reader returns only the requested brand's row, removing the GUC dependency.
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
    this.cache.set(brandId, result);
    return result;
  }

  /** Drop the cached DEK for a brand (call from the erasure path so crypto-shred takes effect). */
  invalidate(brandId: string): void {
    this.cache.delete(brandId);
  }
}

// ── KMS encrypt seam (for PROVISIONING — wrap a freshly-generated salt/DEK) ─────
// The decrypt adapter above is read-only; provisioning a new brand needs to WRAP a plaintext secret.

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
