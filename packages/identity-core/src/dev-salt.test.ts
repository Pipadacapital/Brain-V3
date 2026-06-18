/**
 * dev-salt.test.ts — deterministic per-brand DEV salt (feat-realtime-ingestion-pipeline §3.1).
 *
 * Guards the cross-process parity invariant: resolveDevSaltHex(brandId) is a STABLE,
 * deterministic 64-hex (32-byte) value derived from brandId alone — so the SAME brand
 * yields the SAME salt in every process (apps/core + apps/stream-worker), which makes
 * the SAME email hash identically everywhere. This is the load-bearing identity-stitch
 * invariant. A random/per-process salt would break it.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  resolveDevSaltHex,
  hashIdentifier,
  CONFORMANCE_DEV_SALT_VECTOR,
} from './index.js';

const BRAND_A = '218e5328-0000-0000-0000-000000000000'; // Flipkart-shape id
const BRAND_B = '60d543dc-0000-0000-0000-000000000000'; // Bodd Active-shape id

describe('resolveDevSaltHex — deterministic per-brand dev salt', () => {
  it('returns a 64-hex (32-byte) value (satisfies the D-2 length guard)', () => {
    const hex = resolveDevSaltHex(BRAND_A);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(hex, 'hex').length).toBe(32);
  });

  it('is deterministic: same brandId → same salt across calls (replay-stable)', () => {
    expect(resolveDevSaltHex(BRAND_A)).toBe(resolveDevSaltHex(BRAND_A));
  });

  it('is per-brand: different brandIds → different salts (no cross-brand collision, D-2)', () => {
    expect(resolveDevSaltHex(BRAND_A)).not.toBe(resolveDevSaltHex(BRAND_B));
  });

  it('normalizes brandId (trim + lowercase) so casing/whitespace does not split a brand', () => {
    expect(resolveDevSaltHex('  ' + BRAND_A.toUpperCase() + '  ')).toBe(
      resolveDevSaltHex(BRAND_A),
    );
  });

  it('matches the pinned conformance vector (cross-process parity anchor)', () => {
    // Any process that imports @brain/identity-core MUST compute this exact value.
    const expected = createHash('sha256')
      .update('brain-dev-identity-salt-v1||00000000-0000-0000-0000-000000000001', 'utf8')
      .digest('hex');
    expect(CONFORMANCE_DEV_SALT_VECTOR).toBe(expected);
    expect(resolveDevSaltHex('00000000-0000-0000-0000-000000000001')).toBe(expected);
  });

  it('same email + same brand → identical hashIdentifier output (the cross-process invariant)', () => {
    const saltA = resolveDevSaltHex(BRAND_A);
    const h1 = hashIdentifier('User@Example.com', 'email', saltA);
    const h2 = hashIdentifier('user@example.com', 'email', resolveDevSaltHex(BRAND_A));
    expect(h1).toBe(h2); // normalization + stable salt → stable hash
  });

  it('different brands → different hash for the same email (cross-brand uncorrelatable, D-2)', () => {
    const hA = hashIdentifier('user@example.com', 'email', resolveDevSaltHex(BRAND_A));
    const hB = hashIdentifier('user@example.com', 'email', resolveDevSaltHex(BRAND_B));
    expect(hA).not.toBe(hB);
  });
});
