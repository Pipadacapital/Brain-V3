/**
 * resolve-salt-hex.test.ts — the SHARED salt-resolution order (feat-realtime-ingestion-pipeline §3.1).
 *
 * resolveSaltHex is the ONE branch shared by every salt site in apps/core AND
 * apps/stream-worker (getCoreSaltHex / getWebhookSaltHex / EnvSaltPort / the worker
 * SaltProvider closures). This suite pins the three load-bearing high-stakes invariants:
 *
 *   (1) ENV OVERRIDE / back-compat — an explicit 64-hex IDENTITY_SALT_<brand> wins.
 *   (2) DEV deterministic — with no env var, dev derives the stable resolveDevSaltHex.
 *   (3) PROD UNTOUCHED — with NODE_ENV==='production' and no env var, resolveDevSaltHex
 *       is NEVER reached; resolveSaltHex returns '' so the CALLER's D-2 guard hard-refuses
 *       (we re-create that exact guard here and prove it throws). The dev resolver only
 *       removes the manual-seeding failure mode; it does NOT weaken the prod salt or D-2.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveSaltHex, resolveDevSaltHex } from './index.js';

const BRAND = '218e5328-1111-2222-3333-444455556666';
const ENV_KEY = `IDENTITY_SALT_${BRAND.replace(/-/g, '').toUpperCase()}`;

// Snapshot + restore the two env vars this suite mutates (no cross-test bleed).
const ORIG_NODE_ENV = process.env['NODE_ENV'];
const ORIG_BRAND_SALT = process.env[ENV_KEY];

afterEach(() => {
  if (ORIG_NODE_ENV === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = ORIG_NODE_ENV;
  if (ORIG_BRAND_SALT === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIG_BRAND_SALT;
});

/** The exact D-2 guard every call site applies to resolveSaltHex's result. */
function withD2Guard(brandId: string): string {
  const salt = resolveSaltHex(brandId);
  if (!salt || salt.length !== 64) {
    throw new Error(`salt for brand ${brandId} missing or wrong length (D-2)`);
  }
  return salt;
}

describe('resolveSaltHex — shared resolution order (env → dev-derive → prod-untouched)', () => {
  it('(1) explicit 64-hex IDENTITY_SALT_<brand> overrides (back-compat, any NODE_ENV)', () => {
    const explicit = 'a'.repeat(64);
    process.env[ENV_KEY] = explicit;
    process.env['NODE_ENV'] = 'development';
    expect(resolveSaltHex(BRAND)).toBe(explicit);
    // Override wins even in production.
    process.env['NODE_ENV'] = 'production';
    expect(resolveSaltHex(BRAND)).toBe(explicit);
  });

  it('(1b) a WRONG-LENGTH env value is NOT accepted (falls through to dev derive in dev)', () => {
    process.env[ENV_KEY] = 'tooshort'; // not 64 hex → ignored
    process.env['NODE_ENV'] = 'development';
    expect(resolveSaltHex(BRAND)).toBe(resolveDevSaltHex(BRAND));
  });

  it('(2) DEV, no env var → deterministic resolveDevSaltHex (zero-seeding, scales to all brands)', () => {
    delete process.env[ENV_KEY];
    process.env['NODE_ENV'] = 'development';
    expect(resolveSaltHex(BRAND)).toBe(resolveDevSaltHex(BRAND));
    // test/unset NODE_ENV is also non-production → dev path.
    delete process.env['NODE_ENV'];
    expect(resolveSaltHex(BRAND)).toBe(resolveDevSaltHex(BRAND));
  });

  it('(3) PROD, no env var → resolveDevSaltHex NEVER reached; returns "" so D-2 guard fires', () => {
    delete process.env[ENV_KEY];
    process.env['NODE_ENV'] = 'production';
    // resolveSaltHex itself does not crash — it returns the empty prod env value.
    expect(resolveSaltHex(BRAND)).toBe('');
    // and is NOT the dev-derived value (prod path is provably untouched).
    expect(resolveSaltHex(BRAND)).not.toBe(resolveDevSaltHex(BRAND));
    // the CALLER's D-2 guard is the single crash point → hard-refusal preserved.
    expect(() => withD2Guard(BRAND)).toThrow(/D-2/);
  });

  it('(3b) PROD WITH a valid env salt → uses it (prod KMS/seeded path intact, no crash)', () => {
    const prodSalt = 'b'.repeat(64);
    process.env[ENV_KEY] = prodSalt;
    process.env['NODE_ENV'] = 'production';
    expect(resolveSaltHex(BRAND)).toBe(prodSalt);
    expect(withD2Guard(BRAND)).toBe(prodSalt);
  });

  it('D-2: a wrong-length salt is refused at the guard, never used to hash', () => {
    process.env[ENV_KEY] = 'deadbeef'; // 8 chars, not 64
    process.env['NODE_ENV'] = 'production';
    expect(() => withD2Guard(BRAND)).toThrow(/D-2/);
  });
});
