/**
 * serving-cache.test.ts — ServingCacheReader (Redis-fronted hot serving reads).
 *
 * Proves the cache chokepoint that fronts the Trino serving reads:
 *   1. flag OFF  → pure pass-through (compute() every call; cache untouched).
 *   2. flag ON   → first read computes + caches; second read serves from cache (compute NOT re-run).
 *   3. keys are brand_id-LEADING (the isolation/invalidation invariant).
 *   4. different params → different keys (independent caching).
 *   5. FAIL-SOFT: a cache GET error falls back to a direct compute (read still succeeds).
 *   6. a real compute (Trino) error PROPAGATES (never swallowed, never retried).
 */

import { describe, it, expect, vi } from 'vitest';
import { createServingCacheReader, hashParams } from './serving-cache.js';
import type { AnalyticsCachePort } from './analytics-cache.js';

const BRAND_A = 'aaaa1111-0000-4000-8000-aaaaaaaaaaaa';
const BRAND_B = 'bbbb2222-0000-4000-8000-bbbbbbbbbbbb';

/** A minimal in-memory AnalyticsCachePort that records every key it sees. */
function makeFakeCache(): AnalyticsCachePort & { keys: string[]; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const keys: string[] = [];
  return {
    keys,
    store,
    async get<T>(key: string): Promise<T | null> {
      keys.push(key);
      return (store.has(key) ? (store.get(key) as T) : null);
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
    async invalidate(key: string): Promise<void> {
      store.delete(key);
    },
    async getOrSet<T>(key: string, compute: () => Promise<T>, _ttlMs: number): Promise<T> {
      keys.push(key);
      if (store.has(key)) return store.get(key) as T;
      const v = await compute();
      store.set(key, v);
      return v;
    },
  };
}

describe('ServingCacheReader — flag gate', () => {
  it('flag OFF → pass-through: compute() runs every call, cache never touched', async () => {
    const cache = makeFakeCache();
    const reader = createServingCacheReader({ cache, servingVersion: 'v1', ttlMs: 1000, enabled: false });
    const compute = vi.fn(async () => ({ value: 42 }));

    const a = await reader.read(BRAND_A, 'realized_revenue', { from: 'x' }, compute);
    const b = await reader.read(BRAND_A, 'realized_revenue', { from: 'x' }, compute);

    expect(a).toEqual({ value: 42 });
    expect(b).toEqual({ value: 42 });
    expect(compute).toHaveBeenCalledTimes(2); // no caching
    expect(cache.keys).toHaveLength(0); // cache untouched
  });
});

describe('ServingCacheReader — flag ON caching', () => {
  it('first read computes + caches; second read serves from cache (compute NOT re-run)', async () => {
    const cache = makeFakeCache();
    const reader = createServingCacheReader({ cache, servingVersion: 'v1', ttlMs: 1000, enabled: true });
    const compute = vi.fn(async () => ({ value: 7 }));

    const a = await reader.read(BRAND_A, 'kpi_summary', { asOf: '2026-01-01' }, compute);
    const b = await reader.read(BRAND_A, 'kpi_summary', { asOf: '2026-01-01' }, compute);

    expect(a).toEqual({ value: 7 });
    expect(b).toEqual({ value: 7 });
    expect(compute).toHaveBeenCalledTimes(1); // second read is a cache hit
  });

  it('keys are brand_id-LEADING (isolation/invalidation invariant)', async () => {
    const cache = makeFakeCache();
    const reader = createServingCacheReader({ cache, servingVersion: 'v1', ttlMs: 1000, enabled: true });
    await reader.read(BRAND_A, 'kpi_summary', { asOf: '2026-01-01' }, async () => 1);
    expect(cache.keys[0]!.startsWith(`${BRAND_A}:`)).toBe(true);
    expect(cache.keys[0]).toBe(`${BRAND_A}:kpi_summary:${hashParams({ asOf: '2026-01-01' })}:v1`);
  });

  it('different brand / params / params-order produce distinct & stable keys', async () => {
    const cache = makeFakeCache();
    const reader = createServingCacheReader({ cache, servingVersion: 'v1', ttlMs: 1000, enabled: true });
    await reader.read(BRAND_A, 'm', { from: 'a', to: 'b' }, async () => 1);
    await reader.read(BRAND_B, 'm', { from: 'a', to: 'b' }, async () => 1);
    await reader.read(BRAND_A, 'm', { from: 'a', to: 'c' }, async () => 1);
    // brand A and brand B differ; the two A reads with different params differ.
    expect(new Set(cache.keys).size).toBe(3);
    // params order does not matter (canonicalized): same key regardless of key order.
    expect(hashParams({ from: 'a', to: 'b' })).toBe(hashParams({ to: 'b', from: 'a' }));
  });
});

describe('ServingCacheReader — fail-soft', () => {
  it('cache GET error → falls back to a direct compute (read still succeeds)', async () => {
    const cache = makeFakeCache();
    cache.getOrSet = vi.fn(async () => {
      throw new Error('redis ECONNREFUSED'); // cache layer down BEFORE compute runs
    });
    const reader = createServingCacheReader({ cache, servingVersion: 'v1', ttlMs: 1000, enabled: true });
    const compute = vi.fn(async () => ({ value: 99 }));

    const result = await reader.read(BRAND_A, 'm', { p: 1 }, compute);
    expect(result).toEqual({ value: 99 }); // served despite cache failure
    expect(compute).toHaveBeenCalledTimes(1); // direct read
  });

  it('a real compute (Trino) error PROPAGATES (not swallowed, not retried)', async () => {
    const cache = makeFakeCache();
    const reader = createServingCacheReader({ cache, servingVersion: 'v1', ttlMs: 1000, enabled: true });
    const compute = vi.fn(async () => {
      throw new Error('Trino query error: table does not exist');
    });

    await expect(reader.read(BRAND_A, 'm', { p: 1 }, compute)).rejects.toThrow(/Trino query error/);
    expect(compute).toHaveBeenCalledTimes(1); // exactly once — no double-read on a genuine error
  });
});
