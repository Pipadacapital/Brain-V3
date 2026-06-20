/**
 * RedisOAuthStateStore.live.test.ts — the Redis-backed OAuth state store (live Redis).
 *
 * Proves the production store honours the IOAuthStateStore contract end-to-end:
 *   1. set → consume returns the server-stored brandId (MED-CALLBACK-01).
 *   2. single-use (NN-4) — a second consume of the same state returns null.
 *   3. unknown state → null (honest miss, no throw).
 *   4. TTL expiry — a 1-second nonce is gone after it lapses.
 *   5. collision — set on an already-held state refuses (never rebinds a brand).
 *   6. brandId is the VALUE, derivable from state alone (no client-supplied brand).
 *
 * REQUIRES: Redis on localhost:6379 (the dev brainv3-redis container). SKIP_IF_NO_REDIS guards CI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { RedisOAuthStateStore } from './RedisOAuthStateStore.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

const BRAND_A = 'aaaa0001-0a1a-4a1a-8a1a-000000000001';
const BRAND_B = 'aaaa0001-0a1a-4a1a-8a1a-000000000002';

let redis: Redis;
let store: RedisOAuthStateStore;
let redisAvailable = false;

// Unique-per-run state values so parallel/repeat runs never collide on a shared dev Redis.
const tag = `test-${process.pid}-${Math.floor(performance.now())}`;
const usedKeys: string[] = [];
function freshState(name: string): string {
  const s = `${tag}-${name}`;
  usedKeys.push(`shopify:oauth:state:${s}`);
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  try {
    redis = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1, connectTimeout: 2000 });
    await redis.ping();
    store = new RedisOAuthStateStore(redis);
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  }
});

afterAll(async () => {
  if (redisAvailable) {
    if (usedKeys.length > 0) await redis.del(...usedKeys).catch(() => undefined);
    await redis.quit().catch(() => undefined);
  }
});

describe('RedisOAuthStateStore (live Redis)', () => {
  it('SKIP_IF_NO_REDIS', () => {
    if (!redisAvailable) console.warn('[oauth-state-redis] Redis unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('1. set → consume returns the server-stored brandId', async () => {
    if (!redisAvailable) return;
    const state = freshState('happy');
    await store.set(BRAND_A, state, 900);
    const got = await store.consumeAndGetBrandId(state);
    expect(got).toEqual({ brandId: BRAND_A });
  });

  it('2. single-use — a second consume returns null (NN-4)', async () => {
    if (!redisAvailable) return;
    const state = freshState('single-use');
    await store.set(BRAND_A, state, 900);
    const first = await store.consumeAndGetBrandId(state);
    expect(first).toEqual({ brandId: BRAND_A });
    const second = await store.consumeAndGetBrandId(state);
    expect(second).toBeNull();
  });

  it('3. unknown state → null (honest miss)', async () => {
    if (!redisAvailable) return;
    const got = await store.consumeAndGetBrandId(freshState('never-set'));
    expect(got).toBeNull();
  });

  it('4. TTL expiry — a 1-second nonce is gone after it lapses', async () => {
    if (!redisAvailable) return;
    const state = freshState('ttl');
    await store.set(BRAND_A, state, 1);
    await sleep(1200);
    const got = await store.consumeAndGetBrandId(state);
    expect(got).toBeNull();
  });

  it('5. collision — set on a held state refuses (never rebinds a brand)', async () => {
    if (!redisAvailable) return;
    const state = freshState('collision');
    await store.set(BRAND_A, state, 900);
    await expect(store.set(BRAND_B, state, 900)).rejects.toThrow();
    // The original brand still wins on consume.
    const got = await store.consumeAndGetBrandId(state);
    expect(got).toEqual({ brandId: BRAND_A });
  });

  it('6. brandId is derivable from state alone (MED-CALLBACK-01)', async () => {
    if (!redisAvailable) return;
    const state = freshState('server-trust');
    await store.set(BRAND_B, state, 900);
    // The consumer supplies ONLY the state — brandId comes from the server-side record.
    const got = await store.consumeAndGetBrandId(state);
    expect(got?.brandId).toBe(BRAND_B);
  });
});
