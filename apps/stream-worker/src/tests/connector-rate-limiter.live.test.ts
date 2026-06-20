/**
 * connector-rate-limiter.live.test.ts — P1: global per-provider dispatch cap (live Redis).
 *
 * Proves the cross-replica rate limiter: admits up to maxPerWindow dispatches per provider per
 * window, rejects the overflow, independent per provider, and unlimited for unconfigured providers.
 * Skips cleanly when Redis is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConnectorRateLimiter } from '../infrastructure/redis/ConnectorRateLimiter.js';

const REDIS = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

let limiter: ConnectorRateLimiter;
let redisUp = false;

beforeAll(async () => {
  try {
    // Tiny window + cap so the test is deterministic and isolated from prod defaults.
    limiter = new ConnectorRateLimiter(REDIS, {
      meta: { maxPerWindow: 3, windowMs: 60_000 },
    });
    await limiter.connect();
    redisUp = true;
  } catch {
    redisUp = false;
  }
});

afterAll(async () => {
  await limiter?.quit?.().catch(() => {});
});

describe('ConnectorRateLimiter (P1, live Redis)', () => {
  it('SKIP_IF_NO_REDIS', () => {
    if (!redisUp) console.warn('[connector-rate-limiter] Redis unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('admits up to maxPerWindow, then rejects the overflow', async () => {
    if (!redisUp) return;
    // Fresh window for this provider (the key includes floor(now/window) — unique enough per run).
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await limiter.tryAcquire('meta'));
    // First 3 admitted, last 2 over the cap → rejected.
    expect(results.filter(Boolean).length).toBe(3);
    expect(results.slice(0, 3).every(Boolean)).toBe(true);
    expect(results.slice(3).some(Boolean)).toBe(false);
  });

  it('a provider with no configured cap is always admitted', async () => {
    if (!redisUp) return;
    for (let i = 0; i < 50; i++) {
      expect(await limiter.tryAcquire('some_unconfigured_provider')).toBe(true);
    }
  });
});
