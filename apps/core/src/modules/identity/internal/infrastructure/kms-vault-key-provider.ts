/**
 * KmsVaultKeyProvider — production VaultKeyProvider (P0-C). Unwraps the per-brand DEK from
 * brand_keyring via AWS KMS so the contact_pii vault encrypts/decrypts with a real,
 * KMS-protected key (replacing the default-closed Unwired provider).
 *
 * brand_keyring (0001) stores, per brand: kms_key_id (the CMK), wrapped_dek_b64 (the
 * KMS-wrapped DEK ciphertext), key_version, is_active. We KMS-Decrypt the wrapped blob to
 * recover the 32-byte plaintext DEK — which lives ONLY in memory (I-S09), never persisted.
 *
 * Crypto-shred / DPDP erasure (I-S05): when a brand's keyring is deactivated (is_active=FALSE)
 * — or the CMK is disabled in KMS — the DEK can no longer be recovered and every vaulted row
 * is permanently unreadable. getDek() fails closed on is_active=FALSE. Call invalidate(brandId)
 * from the erasure path to drop any in-memory cached DEK immediately.
 *
 * The KMS call is behind KmsDecryptPort so the provider is unit-testable without AWS.
 */
import type { Pool } from 'pg';
import type { VaultKeyProvider } from '../application/contact-pii-vault.service.js';

/** Minimal KMS decrypt seam — satisfied by AwsKmsDecryptAdapter; mockable in tests. */
export interface KmsDecryptPort {
  decrypt(args: { keyId: string; ciphertextBlob: Uint8Array }): Promise<Buffer>;
}

/** Real AWS KMS adapter. Credentials come from IRSA (no static keys), like AwsSecretsProvider. */
export class AwsKmsDecryptAdapter implements KmsDecryptPort {
  // The KMS client is created lazily so importing this module never requires the SDK at
  // load time (and dev/test paths that never call decrypt() pay nothing).
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
      throw new Error('[kms-vault] KMS Decrypt returned no plaintext');
    }
    return Buffer.from(out.Plaintext);
  }
}

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
      throw new Error(`[kms-vault] no brand_keyring row for brand ${brandId}`);
    }
    if (!row.is_active) {
      // Crypto-shred: the brand's key is revoked → vaulted PII is permanently unrecoverable.
      throw new Error(`[kms-vault] brand_keyring for ${brandId} is inactive (crypto-shred / erased)`);
    }

    const dek = await this.kms.decrypt({
      keyId: row.kms_key_id,
      ciphertextBlob: Buffer.from(row.wrapped_dek_b64, 'base64'),
    });
    if (dek.length !== 32) {
      throw new Error(`[kms-vault] unwrapped DEK is ${dek.length} bytes; expected 32 (AES-256)`);
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
