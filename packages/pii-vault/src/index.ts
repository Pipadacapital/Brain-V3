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
import type { Pool } from 'pg';
import { deriveDevVaultDek } from '@brain/identity-core';

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

    const r = await this.pool.query<{
      kms_key_id: string;
      wrapped_dek_b64: string;
      key_version: number;
      is_active: boolean;
    }>(
      `SELECT kms_key_id, wrapped_dek_b64, key_version, is_active
         FROM brand_keyring WHERE brand_id = $1`,
      [brandId],
    );
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
