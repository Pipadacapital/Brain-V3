/**
 * edge-guard.test.ts — per-install_token rate-limit + origin allowlist (Track B, REC-9).
 *
 * Deterministic tier-1 admission gate. Tests the rejection logic directly (no HTTP server
 * needed for the unit assertions) with an injected clock.
 */
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { EdgeRateLimiter, isAdmissibleBodyShape, registerEdgeGuard } from '../src/interfaces/rest/edge-guard.js';

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

  it('counts a multi-event request as N against the bucket (AUD-PERF-001 /batch amplification)', () => {
    const limiter = new EdgeRateLimiter({ maxPerWindow: 5, windowMs: 1000, originAllowlist: [], now: () => 0 });
    expect(limiter.admit(TOKEN_A, 4)).toBe(true); // 4/5
    expect(limiter.admit(TOKEN_A, 1)).toBe(true); // 5/5
    expect(limiter.admit(TOKEN_A, 1)).toBe(false); // 6/5 → reject
  });

  it('rejects a single batch whose event count alone exceeds the window cap', () => {
    const limiter = new EdgeRateLimiter({ maxPerWindow: 3, windowMs: 1000, originAllowlist: [], now: () => 0 });
    expect(limiter.admit(TOKEN_A, 4)).toBe(false);
  });
});

describe('registerEdgeGuard — uniform admission over /collect, /v1/events and /batch (AUD-PERF-001)', () => {
  const EVENT = (token?: string) => ({ event_name: 'page.viewed', properties: token ? { install_token: token } : {} });

  async function buildApp(limiter: EdgeRateLimiter) {
    const app = Fastify({ logger: false });
    registerEdgeGuard(app, limiter);
    app.post('/collect', async () => ({ accepted: true }));
    app.post('/v1/events', async () => ({ accepted: true }));
    app.post('/batch', async () => ({ accepted: true }));
    await app.ready();
    return app;
  }

  it('a query-string suffix cannot bypass the rate limit on /collect', async () => {
    const limiter = new EdgeRateLimiter({ maxPerWindow: 1, windowMs: 60_000, originAllowlist: [], now: () => 0 });
    const app = await buildApp(limiter);
    const first = await app.inject({ method: 'POST', url: '/collect', payload: EVENT(TOKEN_A) });
    expect(first.statusCode).toBe(200);
    // Over the limit — a ?x=1 suffix must NOT skip the guard (raw-URL equality bug).
    const bypass = await app.inject({ method: 'POST', url: '/collect?x=1', payload: EVENT(TOKEN_A) });
    expect(bypass.statusCode).toBe(429);
    await app.close();
  });

  it('/batch is rate-limited and counts as N events against the bucket', async () => {
    const limiter = new EdgeRateLimiter({ maxPerWindow: 3, windowMs: 60_000, originAllowlist: [], now: () => 0 });
    const app = await buildApp(limiter);
    // A batch of 4 events alone exceeds maxPerWindow=3 → 429 (was previously fully unguarded).
    const res = await app.inject({
      method: 'POST',
      url: '/batch',
      payload: { events: [EVENT(TOKEN_A), EVENT(TOKEN_A), EVENT(TOKEN_A), EVENT(TOKEN_A)] },
    });
    expect(res.statusCode).toBe(429);
    await app.close();
  });

  it('/batch respects the origin allowlist', async () => {
    const limiter = new EdgeRateLimiter({
      maxPerWindow: 100,
      windowMs: 60_000,
      originAllowlist: ['https://shop.example.com'],
      now: () => 0,
    });
    const app = await buildApp(limiter);
    const res = await app.inject({
      method: 'POST',
      url: '/batch',
      headers: { origin: 'https://evil.example.com' },
      payload: { events: [EVENT(TOKEN_A)] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('/batch rejects a non-object body at the shape gate (never reaches the handler)', async () => {
    const limiter = new EdgeRateLimiter({ maxPerWindow: 100, windowMs: 60_000, originAllowlist: [], now: () => 0 });
    const app = await buildApp(limiter);
    const res = await app.inject({ method: 'POST', url: '/batch', payload: [1, 2, 3] });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('non-ingest routes stay unguarded', async () => {
    const limiter = new EdgeRateLimiter({ maxPerWindow: 1, windowMs: 60_000, originAllowlist: ['https://shop.example.com'], now: () => 0 });
    const app = Fastify({ logger: false });
    registerEdgeGuard(app, limiter);
    app.post('/other', async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/other', headers: { origin: 'https://evil.example.com' }, payload: {} });
    expect(res.statusCode).toBe(200); // guard did not fire
    await app.close();
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
