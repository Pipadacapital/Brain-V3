/**
 * IoredisCacheAdapter — stampede-guard unit tests (Gap 3, serving-layer gaps).
 *
 * Exercises the TWO guard layers with a fake in-memory Redis (no real Redis):
 *   1. in-process Promise-map coalescing (pre-existing behavior — must be preserved);
 *   2. the distributed SET-NX rebuild lock: winner computes + releases, loser polls
 *      the value key and serves the winner's write, poll-timeout falls back to a
 *      direct compute, and ANY lock-op failure degrades to the pre-lock behavior.
 */
import { describe, expect, it } from 'vitest';
import { IoredisCacheAdapter, type RedisCacheClient } from './analytics-cache.js';

const KEY = 'brand-a:realized_revenue:hash1:v1';
const LOCK_KEY = `${KEY}:lock`;

/** In-memory fake with real SET ... PX <ttl> NX semantics (no TTL clock — entries live forever). */
function makeFakeRedis(opts?: { failOnLockSet?: boolean }) {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const client: RedisCacheClient = {
    async get(key) {
      calls.push(`get:${key}`);
      return store.get(key) ?? null;
    },
    async set(key, value, ...args) {
      calls.push(`set:${key}`);
      const isNx = args.includes('NX');
      if (isNx && opts?.failOnLockSet) throw new Error('redis down');
      if (isNx && store.has(key)) return null; // NX: only set when absent
      store.set(key, value);
      return 'OK';
    },
    async del(key) {
      calls.push(`del:${key}`);
      return store.delete(key) ? 1 : 0;
    },
  };
  return { client, store, calls };
}

const IMMEDIATE_SLEEP = async (): Promise<void> => {};

describe('IoredisCacheAdapter.getOrSet — distributed lock', () => {
  it('lock winner computes once, stores the value, and releases the lock', async () => {
    const { client, store } = makeFakeRedis();
    const adapter = new IoredisCacheAdapter(client, undefined, IMMEDIATE_SLEEP);
    let computes = 0;
    const value = await adapter.getOrSet(KEY, async () => {
      computes++;
      // While computing, the lock must be HELD (visible to other instances).
      expect(store.has(LOCK_KEY)).toBe(true);
      return { n: 42 };
    }, 60_000);
    expect(value).toEqual({ n: 42 });
    expect(computes).toBe(1);
    expect(store.has(KEY)).toBe(true); // value stored
    expect(store.has(LOCK_KEY)).toBe(false); // lock released
  });

  it('lock loser polls and serves the winner-instance write WITHOUT computing', async () => {
    const { client, store } = makeFakeRedis();
    // Another INSTANCE already holds the lock.
    store.set(LOCK_KEY, 'other-instance-token');
    // Fake sleep simulates the winner instance landing its value write mid-poll.
    const sleep = async (): Promise<void> => {
      store.set(KEY, JSON.stringify({ n: 7 }));
    };
    const adapter = new IoredisCacheAdapter(client, undefined, sleep);
    let computes = 0;
    const value = await adapter.getOrSet(KEY, async () => {
      computes++;
      return { n: 999 };
    }, 60_000);
    expect(value).toEqual({ n: 7 }); // the winner's value, not ours
    expect(computes).toBe(0);
    expect(store.get(LOCK_KEY)).toBe('other-instance-token'); // loser never releases a foreign lock
  });

  it('lock loser falls back to a direct compute when the value never lands (poll timeout)', async () => {
    const { client, store } = makeFakeRedis();
    store.set(LOCK_KEY, 'other-instance-token');
    const adapter = new IoredisCacheAdapter(
      client,
      { pollIntervalMs: 10, maxPollMs: 30 }, // 3 polls, value never appears
      IMMEDIATE_SLEEP,
    );
    let computes = 0;
    const value = await adapter.getOrSet(KEY, async () => {
      computes++;
      return { n: 1 };
    }, 60_000);
    expect(value).toEqual({ n: 1 });
    expect(computes).toBe(1); // never blocked forever on a foreign lock
  });

  it('degrades to a direct compute when the lock op throws (fail-open)', async () => {
    const { client, store } = makeFakeRedis({ failOnLockSet: true });
    const adapter = new IoredisCacheAdapter(client, undefined, IMMEDIATE_SLEEP);
    let computes = 0;
    const value = await adapter.getOrSet(KEY, async () => {
      computes++;
      return { n: 5 };
    }, 60_000);
    expect(value).toEqual({ n: 5 });
    expect(computes).toBe(1);
    expect(store.has(KEY)).toBe(true); // value still stored (plain set has no NX → no simulated failure)
  });

  it('enabled=false restores the pure in-process behavior (no lock keys touched)', async () => {
    const { client, store, calls } = makeFakeRedis();
    const adapter = new IoredisCacheAdapter(client, { enabled: false }, IMMEDIATE_SLEEP);
    await adapter.getOrSet(KEY, async () => ({ n: 3 }), 60_000);
    expect(store.has(LOCK_KEY)).toBe(false);
    expect(calls.filter((c) => c.includes(LOCK_KEY))).toHaveLength(0);
  });

  it('a compute error propagates and the lock is still released', async () => {
    const { client, store } = makeFakeRedis();
    const adapter = new IoredisCacheAdapter(client, undefined, IMMEDIATE_SLEEP);
    await expect(
      adapter.getOrSet(KEY, async () => {
        throw new Error('trino query failed');
      }, 60_000),
    ).rejects.toThrow('trino query failed');
    expect(store.has(LOCK_KEY)).toBe(false); // no orphaned lock after a failed compute
    expect(store.has(KEY)).toBe(false);
  });
});

describe('IoredisCacheAdapter.getOrSet — pre-existing behavior preserved', () => {
  it('cache hit short-circuits (no compute, no lock)', async () => {
    const { client, store, calls } = makeFakeRedis();
    store.set(KEY, JSON.stringify({ n: 11 }));
    const adapter = new IoredisCacheAdapter(client, undefined, IMMEDIATE_SLEEP);
    let computes = 0;
    const value = await adapter.getOrSet(KEY, async () => {
      computes++;
      return { n: 0 };
    }, 60_000);
    expect(value).toEqual({ n: 11 });
    expect(computes).toBe(0);
    expect(calls.filter((c) => c.includes(LOCK_KEY))).toHaveLength(0);
  });

  it('in-process coalescing: concurrent misses share ONE compute', async () => {
    const { client } = makeFakeRedis();
    const adapter = new IoredisCacheAdapter(client, undefined, IMMEDIATE_SLEEP);
    let computes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compute = async (): Promise<{ n: number }> => {
      computes++;
      await gate;
      return { n: computes };
    };
    const p1 = adapter.getOrSet(KEY, compute, 60_000);
    const p2 = adapter.getOrSet(KEY, compute, 60_000);
    release();
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(computes).toBe(1);
    expect(v1).toEqual({ n: 1 });
    expect(v2).toEqual({ n: 1 });
  });

  it('bigint values survive the store round-trip (tagged token)', async () => {
    const { client } = makeFakeRedis();
    const adapter = new IoredisCacheAdapter(client, undefined, IMMEDIATE_SLEEP);
    await adapter.getOrSet(KEY, async () => ({ amount_minor: 1_746_754_034n }), 60_000);
    const cached = await adapter.get<{ amount_minor: bigint }>(KEY);
    expect(cached?.amount_minor).toBe(1_746_754_034n);
  });
});
