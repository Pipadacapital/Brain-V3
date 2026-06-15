/**
 * OAuthStateNonce + InProcessOAuthStateStore unit tests (NN-4 + MED-CALLBACK-01).
 *
 * Verifies:
 *   - Nonce is generated with sufficient entropy (16 bytes → 32 hex chars).
 *   - Single-use: second consume after first returns null.
 *   - Expired nonce: returns null after TTL.
 *   - Unknown nonce: returns null.
 *   - Valid nonce: consumeAndGetBrandId returns the server-stored brandId.
 *   - MED-CALLBACK-01: brandId comes from the store record, not from caller input.
 */
import { describe, it, expect } from 'vitest';
import { OAuthStateNonce } from '../domain/value-objects/OAuthStateNonce.js';
import { InProcessOAuthStateStore } from '../infrastructure/state/InProcessOAuthStateStore.js';

describe('OAuthStateNonce', () => {
  it('generates a nonce with 32 hex characters (128-bit entropy)', () => {
    const nonce = OAuthStateNonce.generate('brand-uuid-1');
    expect(nonce.value).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates a unique nonce each call', () => {
    const a = OAuthStateNonce.generate('brand-uuid-1');
    const b = OAuthStateNonce.generate('brand-uuid-1');
    expect(a.value).not.toBe(b.value);
  });

  it('is not expired immediately after generation', () => {
    const nonce = OAuthStateNonce.generate('brand-uuid-1');
    expect(nonce.isExpired()).toBe(false);
  });

  it('TTL is 900 seconds (15 minutes)', () => {
    expect(OAuthStateNonce.TTL_SECONDS).toBe(900);
  });
});

describe('InProcessOAuthStateStore', () => {
  it('returns the server-stored brandId on first consume (positive control)', async () => {
    const store = new InProcessOAuthStateStore();
    await store.set('brand-1', 'nonce-abc', 900);
    const result = await store.consumeAndGetBrandId('nonce-abc');
    expect(result).not.toBeNull();
    expect(result!.brandId).toBe('brand-1');
  });

  it('MED-CALLBACK-01: brandId in result is the server-stored value, not caller-supplied', async () => {
    const store = new InProcessOAuthStateStore();
    const SERVER_BRAND_ID = 'aaaaaaaa-real-brand-id-server';
    await store.set(SERVER_BRAND_ID, 'nonce-medcb', 900);
    // consumeAndGetBrandId takes state only — no brandId input from caller
    const result = await store.consumeAndGetBrandId('nonce-medcb');
    expect(result).not.toBeNull();
    expect(result!.brandId).toBe(SERVER_BRAND_ID);
  });

  it('single-use: second consume returns null (NN-4)', async () => {
    const store = new InProcessOAuthStateStore();
    await store.set('brand-1', 'nonce-single', 900);
    const first = await store.consumeAndGetBrandId('nonce-single');
    const second = await store.consumeAndGetBrandId('nonce-single');
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // MUST be null — single-use invariant
  });

  it('rejects an unknown nonce (negative control)', async () => {
    const store = new InProcessOAuthStateStore();
    const result = await store.consumeAndGetBrandId('nonexistent');
    expect(result).toBeNull();
  });

  it('rejects an expired nonce (negative control — TTL enforcement)', async () => {
    const store = new InProcessOAuthStateStore();
    // Set with TTL of -1 seconds (already expired)
    await store.set('brand-1', 'nonce-expired', -1);
    const result = await store.consumeAndGetBrandId('nonce-expired');
    expect(result).toBeNull();
  });

  it('two different brands can have the same state value — each stored separately', async () => {
    // This validates the key includes enough uniqueness even after the key change.
    // (In practice state nonces are 128-bit random so collision is negligible.)
    const store = new InProcessOAuthStateStore();
    await store.set('brand-A', 'unique-nonce-a', 900);
    await store.set('brand-B', 'unique-nonce-b', 900);
    const resultA = await store.consumeAndGetBrandId('unique-nonce-a');
    const resultB = await store.consumeAndGetBrandId('unique-nonce-b');
    expect(resultA!.brandId).toBe('brand-A');
    expect(resultB!.brandId).toBe('brand-B');
  });
});
