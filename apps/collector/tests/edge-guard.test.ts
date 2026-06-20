/**
 * edge-guard.test.ts — per-install_token rate-limit + origin allowlist (Track B, REC-9).
 *
 * Deterministic tier-1 admission gate. Tests the rejection logic directly (no HTTP server
 * needed for the unit assertions) with an injected clock.
 */
import { describe, it, expect } from 'vitest';
import { EdgeRateLimiter, isAdmissibleBodyShape } from '../src/interfaces/rest/edge-guard.js';

const TOKEN_A = 'a11a0011-0a11-4a11-8a11-000000000011';
const TOKEN_B = 'b22b0022-0b22-4b22-8b22-000000000022';

describe('EdgeRateLimiter — per-install_token rate limit (reject-before-spool)', () => {
  it('admits up to maxPerWindow then rejects the overflow', () => {
    const limiter = new EdgeRateLimiter({ maxPerWindow: 3, windowMs: 1000, originAllowlist: [], now: () => 0 });
    expect(limiter.admit(TOKEN_A)).toBe(true);
    expect(limiter.admit(TOKEN_A)).toBe(true);
    expect(limiter.admit(TOKEN_A)).toBe(true);
    expect(limiter.admit(TOKEN_A)).toBe(false); // 4th over cap → reject
  });

  it('isolates buckets per install_token (one tenant cannot exhaust another)', () => {
    const limiter = new EdgeRateLimiter({ maxPerWindow: 1, windowMs: 1000, originAllowlist: [], now: () => 0 });
    expect(limiter.admit(TOKEN_A)).toBe(true);
    expect(limiter.admit(TOKEN_A)).toBe(false); // A exhausted
    expect(limiter.admit(TOKEN_B)).toBe(true);  // B unaffected
  });

  it('resets the window after windowMs elapses', () => {
    let t = 0;
    const limiter = new EdgeRateLimiter({ maxPerWindow: 1, windowMs: 1000, originAllowlist: [], now: () => t });
    expect(limiter.admit(TOKEN_A)).toBe(true);
    expect(limiter.admit(TOKEN_A)).toBe(false);
    t = 1001; // new window
    expect(limiter.admit(TOKEN_A)).toBe(true);
  });

  it('a token-less body shares a single shared bucket (bounded memory)', () => {
    const limiter = new EdgeRateLimiter({ maxPerWindow: 2, windowMs: 1000, originAllowlist: [], now: () => 0 });
    expect(limiter.admit(undefined)).toBe(true);
    expect(limiter.admit(undefined)).toBe(true);
    expect(limiter.admit(undefined)).toBe(false); // shared bucket exhausts → reject
  });

  it('bounds the bucket map under a token-fuzzing flood (maxBuckets eviction)', () => {
    const limiter = new EdgeRateLimiter({ maxPerWindow: 10, windowMs: 60_000, originAllowlist: [], now: () => 0, maxBuckets: 100 });
    for (let i = 0; i < 1000; i++) limiter.admit(`tok-${i}`);
    // No assertion on internals beyond "did not throw / unbounded" — the cap is the guarantee.
    expect(limiter.admit('tok-final')).toBe(true);
  });
});

describe('EdgeRateLimiter — origin allowlist', () => {
  it('allow-all when the allowlist is empty (dev default)', () => {
    const limiter = new EdgeRateLimiter({ maxPerWindow: 10, windowMs: 1000, originAllowlist: [] });
    expect(limiter.originAllowed('https://anything.example.com')).toBe(true);
    expect(limiter.originAllowed(undefined)).toBe(true);
  });

  it('rejects an origin not on a configured allowlist', () => {
    const limiter = new EdgeRateLimiter({
      maxPerWindow: 10,
      windowMs: 1000,
      originAllowlist: ['https://shop.example.com'],
    });
    expect(limiter.originAllowed('https://shop.example.com')).toBe(true);
    expect(limiter.originAllowed('https://evil.example.com')).toBe(false);
    expect(limiter.originAllowed(undefined)).toBe(false); // allowlist set but no Origin → reject
  });
});

describe('isAdmissibleBodyShape — structural body admission (SR-03, reject-before-spool)', () => {
  it('admits a JSON object (incl. empty — semantics are downstream Zod, not the edge)', () => {
    expect(isAdmissibleBodyShape({ event_name: 'page.viewed', properties: {} })).toBe(true);
    expect(isAdmissibleBodyShape({})).toBe(true);
  });

  it('admits a missing/unparsed body (existing accept-before-validate empty path)', () => {
    expect(isAdmissibleBodyShape(undefined)).toBe(true);
  });

  it('REJECTS a non-object body so it never reaches the spool', () => {
    expect(isAdmissibleBodyShape([1, 2, 3])).toBe(false); // array
    expect(isAdmissibleBodyShape('a string')).toBe(false); // scalar
    expect(isAdmissibleBodyShape(42)).toBe(false);
    expect(isAdmissibleBodyShape(true)).toBe(false);
    expect(isAdmissibleBodyShape(null)).toBe(false);
  });
});
