import { describe, expect, it } from 'vitest';
import { REF_PREFIX, brainRef } from './brain-ref.js';

// GOLDEN VECTORS — byte-identical with db/iceberg/spark/_identity_ref_test.py. If these two ever diverge,
// a Spark-written customer_ref would disagree with the API/UI-computed one for the same brain_id.
const GOLDEN: Record<string, string> = {
  '9f2c1a4e-7b33-4c9a-8e21-b4d7f0a10000': 'BRN-KWP1MKKV6D69N3H1PKBZ188000',
  '00000000-0000-0000-0000-000000000000': 'BRN-00000000000000000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff': 'BRN-ZZZZZZZZZZZZZZZZZZZZZZZZZW',
  '018f9a2c-1a4e-7b33-8c9a-8e21b4d7f0a1': 'BRN-067SMB0T9SXK734THRGV9NZGM4',
};

describe('brainRef — public customer_ref', () => {
  it('matches the Python golden vectors byte-for-byte', () => {
    for (const [brainId, expected] of Object.entries(GOLDEN)) {
      expect(brainRef(brainId)).toBe(expected);
    }
  });

  it('is BRN- + 26 Crockford chars', () => {
    const ref = brainRef('9f2c1a4e-7b33-4c9a-8e21-b4d7f0a10000')!;
    expect(ref.startsWith(REF_PREFIX)).toBe(true);
    expect(ref.length).toBe(REF_PREFIX.length + 26);
    for (const ch of ref.slice(REF_PREFIX.length)) {
      expect('0123456789ABCDEFGHJKMNPQRSTVWXYZ').toContain(ch);
    }
  });

  it('is case-insensitive + deterministic', () => {
    expect(brainRef('9F2C1A4E-7B33-4C9A-8E21-B4D7F0A10000')).toBe(
      GOLDEN['9f2c1a4e-7b33-4c9a-8e21-b4d7f0a10000'],
    );
  });

  it('is injective — distinct brain_ids never collide', () => {
    const refs = new Set(Object.keys(GOLDEN).map((k) => brainRef(k)));
    expect(refs.size).toBe(Object.keys(GOLDEN).length);
  });

  it('passes null/empty through as null', () => {
    expect(brainRef(null)).toBeNull();
    expect(brainRef(undefined)).toBeNull();
    expect(brainRef('')).toBeNull();
    expect(brainRef('   ')).toBeNull();
  });

  it('handles a non-UUID input without throwing (sha256 fallback)', () => {
    const ref = brainRef('not-a-uuid')!;
    expect(ref.startsWith(REF_PREFIX)).toBe(true);
    expect(ref.length).toBe(REF_PREFIX.length + 26);
    expect(brainRef('not-a-uuid')).toBe(ref);
  });
});
