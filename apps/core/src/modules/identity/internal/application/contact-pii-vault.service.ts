/**
 * ContactPiiVaultService — the PII vault application service (P0-C).
 *
 * Encrypts on write, decrypts transiently on read. The decrypted value exists only for the
 * duration of a getMatchPii() call (to compute the Meta-format hash at send time) and is
 * NEVER stored or logged (I-S02). Structurally satisfies notification's MatchPiiPort, so
 * main.ts can pass it as the CAPI passback PII port without an import-direction violation.
 *
 * Key provenance is pluggable (VaultKeyProvider): dev derives a deterministic per-brand DEK;
 * prod unwraps the brand_keyring DEK via KMS. The service is DEFAULT-CLOSED in prod — if no
 * real provider is wired it refuses to operate rather than fall back to a dev key.
 */
import { encryptPii, decryptPii, deriveDevVaultDek } from '@brain/identity-core';
import {
  ContactPiiVaultRepository,
  type VaultPiiType,
  type VaultCoverageCounts,
} from '../infrastructure/contact-pii-vault.repository.js';

/** Raw PII returned transiently for a subject — matches notification's MatchPii shape. */
export interface VaultMatchPii {
  email?: string;
  phone?: string;
  regionCode?: string;
}

export interface VaultCoverage {
  resolved_customers: number;
  vaulted_customers: number;
  /** Whole-number percent of resolved customers with at least one vaulted identifier. */
  coverage_pct: number;
  email_count: number;
  phone_count: number;
}

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
 * Default-closed production provider. The real implementation unwraps
 * brand_keyring.wrapped_dek_b64 via AWS KMS (follow-up). Until wired, it throws so the
 * vault NEVER silently uses a weak key in production.
 */
export class UnwiredProdVaultKeyProvider implements VaultKeyProvider {
  async getDek(): Promise<{ dek: Buffer; keyVersion: number }> {
    throw new Error(
      '[pii-vault] production KMS key provider is not wired — refusing to encrypt/decrypt with a non-KMS key (default-closed).',
    );
  }
}

export class ContactPiiVaultService {
  constructor(
    private readonly repo: ContactPiiVaultRepository,
    private readonly keys: VaultKeyProvider,
  ) {}

  /** Encrypt and vault one PII value (idempotent). identifierHash = the salted 64-hex. */
  async put(args: {
    brandId: string;
    brainId: string;
    piiType: VaultPiiType;
    rawValue: string;
    identifierHash: string;
  }): Promise<void> {
    const { dek, keyVersion } = await this.keys.getDek(args.brandId);
    const env = encryptPii(dek, args.rawValue);
    await this.repo.putPii({
      brandId: args.brandId,
      brainId: args.brainId,
      piiType: args.piiType,
      identifierHash: args.identifierHash,
      ciphertext: env.ciphertext,
      iv: env.iv,
      authTag: env.authTag,
      keyVersion,
    });
  }

  /**
   * MatchPiiPort-shaped read: resolve the customer for `subjectHash` and return its decrypted
   * email/phone, or null if nothing is vaulted. The plaintext is returned to the caller and
   * must be discarded immediately after hashing (notification's contract).
   */
  async getMatchPii(args: { brandId: string; subjectHash: string }): Promise<VaultMatchPii | null> {
    const rows = await this.repo.getEnvelopesBySubjectHash(args);
    if (rows.length === 0) return null;
    const out: VaultMatchPii = {};
    for (const row of rows) {
      const { dek } = await this.keys.getDek(args.brandId, row.keyVersion);
      const value = decryptPii(dek, { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag });
      if (row.piiType === 'email') out.email = value;
      else if (row.piiType === 'phone') out.phone = value;
    }
    return out.email || out.phone ? out : null;
  }

  /** Coverage aggregates for the vault-status UI (counts only). */
  async getCoverage(brandId: string): Promise<VaultCoverage> {
    const c: VaultCoverageCounts = await this.repo.countCoverage(brandId);
    const coverage_pct =
      c.resolved_customers > 0
        ? Math.round((c.vaulted_customers / c.resolved_customers) * 100)
        : 0;
    return {
      resolved_customers: c.resolved_customers,
      vaulted_customers: c.vaulted_customers,
      coverage_pct,
      email_count: c.email_count,
      phone_count: c.phone_count,
    };
  }
}
