/**
 * subject-vault-key-provider.test.ts — per-subject DEK (crypto-shred) extension (Task B).
 *
 * Proves:
 *  1. Subject DEK path: encrypt→decrypt round-trip with the subject DEK.
 *  2. is_active=FALSE subject → getDek throws (shredded, permanently unreadable).
 *  3. Absent subject row → brand fallback; decrypts a legacy brand-encrypted row correctly.
 *  4. Dev provider is deterministic per (brand, subject) and differs from the brand DEK and
 *     across subjects (cross-subject uncorrelatable).
 *  5. SubjectCryptoProvisioner generates + KMS-wraps a 32-byte DEK → calls provision_subject_crypto.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  KmsVaultKeyProvider,
  DevVaultKeyProvider,
  SubjectCryptoProvisioner,
  type KmsDecryptPort,
  type KmsEncryptPort,
} from './index.js';
import { encryptPii, decryptPii } from '@brain/identity-core';

const BRAND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUBJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRAND_DEK = randomBytes(32);
const SUBJECT_DEK = randomBytes(32);

const subjectRow = {
  kms_key_id: 'arn:aws:kms:ap-south-1:000000000000:key/subject-key',
  wrapped_dek_b64: Buffer.from('subject-wrapped-blob').toString('base64'),
  key_version: 3,
  is_active: true,
};

const brandRow = {
  kms_key_id: 'arn:aws:kms:ap-south-1:000000000000:key/brand-key',
  wrapped_dek_b64: Buffer.from('brand-wrapped-blob').toString('base64'),
  key_version: 2,
  is_active: true,
};

/**
 * Mock pool that routes by SQL content:
 *   get_subject_keyring → subjectRow
 *   get_brand_keyring   → brandRow
 */
function mockPoolWithSubject(opts: {
  subjectRow: Record<string, unknown> | null;
  brandRow: Record<string, unknown> | null;
}) {
  return {
    query: vi.fn(async (sql: string) => {
      if ((sql as string).includes('get_subject_keyring')) {
        return {
          rows: opts.subjectRow ? [opts.subjectRow] : [],
          rowCount: opts.subjectRow ? 1 : 0,
        };
      }
      return {
        rows: opts.brandRow ? [opts.brandRow] : [],
        rowCount: opts.brandRow ? 1 : 0,
      };
    }),
  } as never;
}

/**
 * Mock KMS decrypt that distinguishes subject from brand by inspecting the ciphertext blob
 * (subject blob contains the string 'subject', brand blob does not).
 */
function mockKmsBoth(subjectDek: Buffer, brandDek: Buffer): KmsDecryptPort {
  return {
    decrypt: vi.fn(async ({ ciphertextBlob }: { keyId: string; ciphertextBlob: Uint8Array }) => {
      const blob = Buffer.from(ciphertextBlob).toString();
      return blob.includes('subject') ? subjectDek : brandDek;
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// KmsVaultKeyProvider — subject DEK path
// ─────────────────────────────────────────────────────────────────────────────

describe('KmsVaultKeyProvider — subject DEK path', () => {
  it('resolves the subject DEK and returns level=subject + correct key_version', async () => {
    const pool = mockPoolWithSubject({ subjectRow, brandRow });
    const kms = mockKmsBoth(SUBJECT_DEK, BRAND_DEK);
    const p = new KmsVaultKeyProvider(pool, kms);
    const result = await p.getDek(BRAND, { subjectId: SUBJECT });
    expect(result.dek.equals(SUBJECT_DEK)).toBe(true);
    expect(result.keyVersion).toBe(3);
    expect(result.level).toBe('subject');
  });

  it('subject DEK: encrypt then decrypt round-trips (proof of correct DEK)', async () => {
    const pool = mockPoolWithSubject({ subjectRow, brandRow });
    const kms = mockKmsBoth(SUBJECT_DEK, BRAND_DEK);
    const p = new KmsVaultKeyProvider(pool, kms);
    const { dek } = await p.getDek(BRAND, { subjectId: SUBJECT });
    const env = encryptPii(dek, 'user@example.com');
    expect(decryptPii(dek, env)).toBe('user@example.com');
  });

  it('caches the subject DEK — KMS is called only once for repeated getDek(same subject)', async () => {
    const decrypt = vi.fn(async () => SUBJECT_DEK);
    const pool = mockPoolWithSubject({ subjectRow, brandRow });
    const p = new KmsVaultKeyProvider(pool, { decrypt });
    await p.getDek(BRAND, { subjectId: SUBJECT });
    await p.getDek(BRAND, { subjectId: SUBJECT });
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it('invalidate(brandId, subjectId) drops the subject cache so next call re-fetches', async () => {
    const decrypt = vi.fn(async () => SUBJECT_DEK);
    const pool = mockPoolWithSubject({ subjectRow, brandRow });
    const p = new KmsVaultKeyProvider(pool, { decrypt });
    await p.getDek(BRAND, { subjectId: SUBJECT });
    p.invalidate(BRAND, SUBJECT);
    await p.getDek(BRAND, { subjectId: SUBJECT });
    expect(decrypt).toHaveBeenCalledTimes(2);
  });

  it('FAILS CLOSED on is_active=FALSE for subject (per-subject crypto-shred, row unreadable)', async () => {
    const pool = mockPoolWithSubject({
      subjectRow: { ...subjectRow, is_active: false },
      brandRow,
    });
    const kms = mockKmsBoth(SUBJECT_DEK, BRAND_DEK);
    const p = new KmsVaultKeyProvider(pool, kms);
    await expect(p.getDek(BRAND, { subjectId: SUBJECT })).rejects.toThrow('inactive');
  });

  it('absent subject row → brand fallback; decrypts a legacy brand-encrypted row', async () => {
    const pool = mockPoolWithSubject({ subjectRow: null, brandRow });
    const decrypt = vi.fn(async () => BRAND_DEK);
    const p = new KmsVaultKeyProvider(pool, { decrypt });
    const result = await p.getDek(BRAND, { subjectId: SUBJECT });
    expect(result.dek.equals(BRAND_DEK)).toBe(true);
    expect(result.level).toBe('brand');
    // Verify the returned DEK can actually decrypt a legacy brand-encrypted row.
    const legacyEnv = encryptPii(BRAND_DEK, 'legacy@example.com');
    expect(decryptPii(result.dek, legacyEnv)).toBe('legacy@example.com');
  });

  it('brand-only getDek(brandId) returns level=brand — backward compat preserved', async () => {
    const pool = mockPoolWithSubject({ subjectRow, brandRow });
    const decrypt = vi.fn(async () => BRAND_DEK);
    const p = new KmsVaultKeyProvider(pool, { decrypt });
    const result = await p.getDek(BRAND);
    expect(result.level).toBe('brand');
    expect(result.dek.equals(BRAND_DEK)).toBe(true);
  });

  it('rejects a non-32-byte unwrapped subject DEK', async () => {
    const pool = mockPoolWithSubject({ subjectRow, brandRow });
    const p = new KmsVaultKeyProvider(pool, { decrypt: vi.fn(async () => randomBytes(16)) });
    await expect(p.getDek(BRAND, { subjectId: SUBJECT })).rejects.toThrow('expected 32');
  });

  it('subject cache is per-subject — different subjects do not share entries', async () => {
    const OTHER_SUBJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const otherDek = randomBytes(32);
    let callCount = 0;
    const decrypt = vi.fn(async () => {
      // Alternate to simulate two distinct keys
      return callCount++ === 0 ? SUBJECT_DEK : otherDek;
    });
    const pool = mockPoolWithSubject({ subjectRow, brandRow });
    const p = new KmsVaultKeyProvider(pool, { decrypt });
    const a = await p.getDek(BRAND, { subjectId: SUBJECT });
    const b = await p.getDek(BRAND, { subjectId: OTHER_SUBJECT });
    // Both should have been fetched (two KMS calls).
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(a.dek.equals(b.dek)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DevVaultKeyProvider — subject path
// ─────────────────────────────────────────────────────────────────────────────

describe('DevVaultKeyProvider — subject path', () => {
  it('returns a deterministic 32-byte DEK for the same (brand, subject)', async () => {
    const p = new DevVaultKeyProvider();
    const a = await p.getDek(BRAND, { subjectId: SUBJECT });
    const b = await p.getDek(BRAND, { subjectId: SUBJECT });
    expect(a.dek.length).toBe(32);
    expect(a.dek.equals(b.dek)).toBe(true);
    expect(a.level).toBe('subject');
  });

  it('subject DEK differs from the brand DEK for the same brand', async () => {
    const p = new DevVaultKeyProvider();
    const brand = await p.getDek(BRAND);
    const subject = await p.getDek(BRAND, { subjectId: SUBJECT });
    expect(brand.dek.equals(subject.dek)).toBe(false);
  });

  it('DEK differs across subjects (cross-subject uncorrelatable)', async () => {
    const p = new DevVaultKeyProvider();
    const a = await p.getDek(BRAND, { subjectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    const b = await p.getDek(BRAND, { subjectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
    expect(a.dek.equals(b.dek)).toBe(false);
  });

  it('subject DEK round-trips through encryptPii/decryptPii', async () => {
    const p = new DevVaultKeyProvider();
    const { dek } = await p.getDek(BRAND, { subjectId: SUBJECT });
    const env = encryptPii(dek, 'subject@example.com');
    expect(decryptPii(dek, env)).toBe('subject@example.com');
  });

  it('no subjectId → returns level=brand (backward compat)', async () => {
    const p = new DevVaultKeyProvider();
    const r = await p.getDek(BRAND);
    expect(r.level).toBe('brand');
    expect(r.dek.length).toBe(32);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SubjectCryptoProvisioner
// ─────────────────────────────────────────────────────────────────────────────

describe('SubjectCryptoProvisioner', () => {
  it('generates + KMS-wraps a 32-byte DEK and calls provision_subject_crypto', async () => {
    const seen: Uint8Array[] = [];
    const encrypt = vi.fn(async ({ plaintext }: { keyId: string; plaintext: Uint8Array }) => {
      seen.push(plaintext);
      return Buffer.from(`wrapped:${Buffer.from(plaintext).toString('hex').slice(0, 8)}`);
    });
    const kms: KmsEncryptPort = { encrypt };
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [], rowCount: 0 }));
    const pool = { query } as never;

    await new SubjectCryptoProvisioner(pool, kms, 'alias/test-cmk').provision(BRAND, SUBJECT);

    // Exactly one 32-byte DEK encrypted under the configured CMK.
    expect(encrypt).toHaveBeenCalledTimes(1);
    expect(seen[0]!.length).toBe(32);
    // provision_subject_crypto called with (brandId, subjectId, kmsKeyId, wrappedDek_b64).
    expect(query).toHaveBeenCalledTimes(1);
    const args = query.mock.calls[0]![1] as unknown[];
    expect(args[0]).toBe(BRAND);
    expect(args[1]).toBe(SUBJECT);
    expect(args[2]).toBe('alias/test-cmk');
    expect(typeof args[3]).toBe('string'); // base64-encoded wrapped DEK
  });

  it('is idempotent by design (provision_subject_crypto is ON CONFLICT DO NOTHING)', async () => {
    // The provisioner itself always calls the DB; idempotency is enforced at the SQL level.
    // Here we verify it makes exactly one call per provision() invocation (no internal short-circuit).
    const encrypt = vi.fn(async () => Buffer.from('wrapped'));
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const pool = { query } as never;
    const p = new SubjectCryptoProvisioner(pool, { encrypt }, 'alias/cmk');
    await p.provision(BRAND, SUBJECT);
    await p.provision(BRAND, SUBJECT);
    expect(query).toHaveBeenCalledTimes(2); // Each call reaches DB; DB enforces ON CONFLICT DO NOTHING
  });
});
