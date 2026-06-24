/**
 * brand-salt-provider.test.ts — KmsBrandSaltProvider + BrandCryptoProvisioner (0109), no AWS required.
 *
 * Mirrors kms-vault-key-provider.test.ts. Mock pg pool (get_brand_identity_salt rows) + mock KMS
 * encrypt/decrypt ports. Proves: salt unwrap → 64-hex, per-brand cache, invalidate, fail-closed on
 * missing/inactive/wrong-length salt; the dev deterministic salt; and that provisioning generates +
 * KMS-wraps a 32-byte salt + DEK and calls provision_brand_crypto with the wrapped material.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  KmsBrandSaltProvider,
  DevBrandSaltProvider,
  BrandCryptoProvisioner,
  type KmsDecryptPort,
  type KmsEncryptPort,
} from './index.js';

const BRAND = '22222222-2222-4222-8222-222222222222';
const SALT = randomBytes(32);

function mockPool(row: Record<string, unknown> | null) {
  return {
    query: vi.fn(async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 })),
  } as never;
}

function mockDecrypt(salt: Buffer): { port: KmsDecryptPort; calls: () => number } {
  const fn = vi.fn(async () => salt);
  return { port: { decrypt: fn }, calls: () => fn.mock.calls.length };
}

const activeRow = {
  kms_key_id: 'arn:aws:kms:ap-south-1:000000000000:key/abc',
  wrapped_salt_b64: Buffer.from('wrapped-salt-blob').toString('base64'),
  key_version: 1,
  is_active: true,
};

describe('KmsBrandSaltProvider', () => {
  it('unwraps the salt via KMS and returns 64-hex', async () => {
    const kms = mockDecrypt(SALT);
    const p = new KmsBrandSaltProvider(mockPool(activeRow), kms.port);
    const hex = await p.saltHexForBrand(BRAND);
    expect(hex).toBe(SALT.toString('hex'));
    expect(hex.length).toBe(64);
    expect(kms.calls()).toBe(1);
  });

  it('caches per brand — KMS called once across repeated resolves', async () => {
    const kms = mockDecrypt(SALT);
    const p = new KmsBrandSaltProvider(mockPool(activeRow), kms.port);
    await p.saltHexForBrand(BRAND);
    await p.saltHexForBrand(BRAND);
    expect(kms.calls()).toBe(1);
  });

  it('invalidate() drops the cached salt', async () => {
    const kms = mockDecrypt(SALT);
    const p = new KmsBrandSaltProvider(mockPool(activeRow), kms.port);
    await p.saltHexForBrand(BRAND);
    p.invalidate(BRAND);
    await p.saltHexForBrand(BRAND);
    expect(kms.calls()).toBe(2);
  });

  it('fails closed (D-2) when the brand is not provisioned (no row)', async () => {
    const p = new KmsBrandSaltProvider(mockPool(null), mockDecrypt(SALT).port);
    await expect(p.saltHexForBrand(BRAND)).rejects.toThrow('not provisioned');
  });

  it('fails closed when the salt is inactive (crypto-shred)', async () => {
    const p = new KmsBrandSaltProvider(mockPool({ ...activeRow, is_active: false }), mockDecrypt(SALT).port);
    await expect(p.saltHexForBrand(BRAND)).rejects.toThrow('inactive');
  });

  it('rejects a non-32-byte unwrapped salt', async () => {
    const p = new KmsBrandSaltProvider(mockPool(activeRow), mockDecrypt(randomBytes(16)).port);
    await expect(p.saltHexForBrand(BRAND)).rejects.toThrow('expected 32');
  });
});

describe('DevBrandSaltProvider', () => {
  it('returns a deterministic 64-hex salt per brand', async () => {
    const p = new DevBrandSaltProvider();
    const a = await p.saltHexForBrand(BRAND);
    const b = await p.saltHexForBrand(BRAND);
    expect(a.length).toBe(64);
    expect(a).toBe(b);
  });
});

describe('BrandCryptoProvisioner', () => {
  it('generates + KMS-wraps a 32-byte salt and DEK, then calls provision_brand_crypto', async () => {
    const seen: Uint8Array[] = [];
    const encrypt = vi.fn(async ({ plaintext }: { keyId: string; plaintext: Uint8Array }) => {
      seen.push(plaintext);
      return Buffer.from(`wrapped:${Buffer.from(plaintext).toString('hex').slice(0, 8)}`);
    });
    const kms: KmsEncryptPort = { encrypt };
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [], rowCount: 0 }));
    const pool = { query } as never;

    await new BrandCryptoProvisioner(pool, kms, 'alias/test-cmk').provision(BRAND);

    // Two encrypts (salt + DEK), each of a 32-byte random plaintext under the configured CMK.
    expect(encrypt).toHaveBeenCalledTimes(2);
    expect(seen.every((p) => p.length === 32)).toBe(true);
    // salt and DEK are independent random material.
    expect(Buffer.from(seen[0]!).equals(Buffer.from(seen[1]!))).toBe(false);
    // provision_brand_crypto called once with (brand, kmsKeyId, wrappedDek_b64, wrappedSalt_b64).
    expect(query).toHaveBeenCalledTimes(1);
    const args = query.mock.calls[0]![1] as unknown[];
    expect(args[0]).toBe(BRAND);
    expect(args[1]).toBe('alias/test-cmk');
    expect(typeof args[2]).toBe('string');
    expect(typeof args[3]).toBe('string');
  });
});
