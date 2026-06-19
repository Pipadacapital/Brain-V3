/**
 * kms-vault-key-provider.test.ts — KmsVaultKeyProvider logic (P0-C), no AWS required.
 *
 * Uses a mock pg pool (brand_keyring rows) + a mock KmsDecryptPort. Proves: unwrap via KMS,
 * per-brand DEK cache (KMS called once), invalidate(), fail-closed on missing row / inactive
 * keyring (crypto-shred) / wrong DEK length. Also a dev/derived round-trip sanity check.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { KmsVaultKeyProvider, DevVaultKeyProvider, type KmsDecryptPort } from './index.js';

const BRAND = '11111111-1111-4111-8111-111111111111';
const DEK = randomBytes(32);

function mockPool(row: Record<string, unknown> | null) {
  return {
    query: vi.fn(async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 })),
  } as never;
}

function mockKms(dek: Buffer): { port: KmsDecryptPort; calls: () => number } {
  const fn = vi.fn(async () => dek);
  return { port: { decrypt: fn }, calls: () => fn.mock.calls.length };
}

const activeRow = {
  kms_key_id: 'arn:aws:kms:ap-south-1:000000000000:key/abc',
  wrapped_dek_b64: Buffer.from('wrapped-blob').toString('base64'),
  key_version: 2,
  is_active: true,
};

describe('KmsVaultKeyProvider', () => {
  it('unwraps the DEK via KMS and returns the key_version', async () => {
    const kms = mockKms(DEK);
    const p = new KmsVaultKeyProvider(mockPool(activeRow), kms.port);
    const { dek, keyVersion } = await p.getDek(BRAND);
    expect(dek.equals(DEK)).toBe(true);
    expect(keyVersion).toBe(2);
    expect(kms.calls()).toBe(1);
  });

  it('caches per brand — KMS is called once across repeated getDek', async () => {
    const kms = mockKms(DEK);
    const p = new KmsVaultKeyProvider(mockPool(activeRow), kms.port);
    await p.getDek(BRAND);
    await p.getDek(BRAND);
    expect(kms.calls()).toBe(1);
  });

  it('invalidate() drops the cached DEK (erasure / crypto-shred)', async () => {
    const kms = mockKms(DEK);
    const p = new KmsVaultKeyProvider(mockPool(activeRow), kms.port);
    await p.getDek(BRAND);
    p.invalidate(BRAND);
    await p.getDek(BRAND);
    expect(kms.calls()).toBe(2);
  });

  it('fails closed when no brand_keyring row exists', async () => {
    const p = new KmsVaultKeyProvider(mockPool(null), mockKms(DEK).port);
    await expect(p.getDek(BRAND)).rejects.toThrow('no brand_keyring');
  });

  it('fails closed when the keyring is inactive (crypto-shred / erased)', async () => {
    const p = new KmsVaultKeyProvider(mockPool({ ...activeRow, is_active: false }), mockKms(DEK).port);
    await expect(p.getDek(BRAND)).rejects.toThrow('inactive');
  });

  it('rejects a non-32-byte unwrapped DEK', async () => {
    const p = new KmsVaultKeyProvider(mockPool(activeRow), mockKms(randomBytes(16)).port);
    await expect(p.getDek(BRAND)).rejects.toThrow('expected 32');
  });
});

describe('DevVaultKeyProvider', () => {
  it('returns a deterministic 32-byte DEK per brand', async () => {
    const p = new DevVaultKeyProvider();
    const a = await p.getDek(BRAND);
    const b = await p.getDek(BRAND);
    expect(a.dek.length).toBe(32);
    expect(a.dek.equals(b.dek)).toBe(true);
    expect(a.keyVersion).toBe(1);
  });
});
