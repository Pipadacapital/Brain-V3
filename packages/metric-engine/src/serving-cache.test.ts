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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { setCounterSink } from '@brain/observability';
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

describe('ServingCacheReader — hit-rate metric (serving_cache_requests_total)', () => {
  /** Record every counter increment via the observability sink seam. */
  function recordCounters(): { calls: Array<{ name: string; labels: Record<string, string> }>; restore: () => void } {
    const calls: Array<{ name: string; labels: Record<string, string> }> = [];
    const restore = setCounterSink({ add: (name, _value, labels) => calls.push({ name, labels }) });
    return { calls, restore };
  }

  afterEach(() => {
    // Each test restores its own sink; this is a belt-and-braces reset for the default sink.
  });

  it('miss then hit emit result=miss then result=hit with the metric_id label', async () => {
    const cache = makeFakeCache();
    const reader = createServingCacheReader({ cache, servingVersion: 'v1', ttlMs: 1000, enabled: true });
    const { calls, restore } = recordCounters();
    try {
      await reader.read(BRAND_A, 'kpi_summary', { asOf: '2026-01-01' }, async () => ({ value: 1 })); // miss
      await reader.read(BRAND_A, 'kpi_summary', { asOf: '2026-01-01' }, async () => ({ value: 1 })); // hit
    } finally {
      restore();
    }
    const cacheCalls = calls.filter((c) => c.name === 'serving_cache_requests_total');
    expect(cacheCalls.map((c) => c.labels.result)).toEqual(['miss', 'hit']);
    expect(cacheCalls.every((c) => c.labels.metric_id === 'kpi_summary')).toBe(true);
  });

  it('flag OFF emits result=bypass', async () => {
    const cache = makeFakeCache();
    const reader = createServingCacheReader({ cache, servingVersion: 'v1', ttlMs: 1000, enabled: false });
    const { calls, restore } = recordCounters();
    try {
      await reader.read(BRAND_A, 'm', { p: 1 }, async () => 1);
    } finally {
      restore();
    }
    expect(calls.filter((c) => c.name === 'serving_cache_requests_total').map((c) => c.labels.result)).toEqual([
      'bypass',
    ]);
  });

  it('cache-layer error emits result=error (not counted as hit/miss)', async () => {
    const cache = makeFakeCache();
    cache.getOrSet = vi.fn(async () => {
      throw new Error('redis ECONNREFUSED');
    });
    const reader = createServingCacheReader({ cache, servingVersion: 'v1', ttlMs: 1000, enabled: true });
    const { calls, restore } = recordCounters();
    try {
      await reader.read(BRAND_A, 'm', { p: 1 }, async () => 1);
    } finally {
      restore();
    }
    expect(calls.filter((c) => c.name === 'serving_cache_requests_total').map((c) => c.labels.result)).toEqual([
      'error',
    ]);
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

describe('ServingCacheReader — ADR-0019 WS-2 stale-while-revalidate', () => {
  /** Drain the microtask queue so a fire-and-forget background revalidation completes. */
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('swrEnabled reflects enabled AND swr.enabled', () => {
    const cache = makeFakeCache();
    const off = createServingCacheReader({ cache, servingVersion: 'v1', ttlMs: 1000, enabled: true });
    const swrOn = createServingCacheReader({
      cache, servingVersion: 'v1', ttlMs: 1000, enabled: true, swr: { enabled: true, staleGraceMs: 60_000 },
    });
    const cacheOff = createServingCacheReader({
      cache, servingVersion: 'v1', ttlMs: 1000, enabled: false, swr: { enabled: true, staleGraceMs: 60_000 },
    });
    expect(off.swrEnabled).toBe(false); // no swr block
    expect(swrOn.swrEnabled).toBe(true);
    expect(cacheOff.swrEnabled).toBe(false); // cache disabled ⇒ swr inert
  });

  it('swr.enabled=false → identical to today (getOrSet path, plain key, no :swr suffix)', async () => {
    const cache = makeFakeCache();
    const reader = createServingCacheReader({
      cache, servingVersion: 'v1', ttlMs: 1000, enabled: true, swr: { enabled: false, staleGraceMs: 60_000 },
    });
    const compute = vi.fn(async () => ({ value: 7 }));
    await reader.read(BRAND_A, 'kpi_summary', { asOf: 'x' }, compute);
    await reader.read(BRAND_A, 'kpi_summary', { asOf: 'x' }, compute);
    expect(compute).toHaveBeenCalledTimes(1); // cached
    expect(cache.keys.every((k) => !k.endsWith(':swr'))).toBe(true); // plain keyspace, unchanged
  });

  it('SWR keys are :swr-suffixed AND brand_id-LEADING (disjoint keyspace, still isolatable)', async () => {
    const cache = makeFakeCache();
    const reader = createServingCacheReader({
      cache, servingVersion: 'v1', ttlMs: 1000, enabled: true, swr: { enabled: true, staleGraceMs: 60_000 },
    });
    await reader.read(BRAND_A, 'kpi_summary', { asOf: 'x' }, async () => 1);
    expect(cache.keys[0]!.startsWith(`${BRAND_A}:`)).toBe(true);
    expect(cache.keys[0]!.endsWith(':swr')).toBe(true);
  });

  it('fresh hit within soft ttl serves from cache (compute NOT re-run)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const cache = makeFakeCache();
    const reader = createServingCacheReader({
      cache, servingVersion: 'v1', ttlMs: 1000, enabled: true, swr: { enabled: true, staleGraceMs: 60_000 },
    });
    const compute = vi.fn(async () => ({ value: 1 }));
    const a = await reader.read(BRAND_A, 'm', { p: 1 }, compute); // miss
    const b = await reader.read(BRAND_A, 'm', { p: 1 }, compute); // fresh hit (same instant)
    expect(a).toEqual({ value: 1 });
    expect(b).toEqual({ value: 1 });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('past soft ttl serves STALE immediately + revalidates in background; next read is fresh', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const cache = makeFakeCache();
    const reader = createServingCacheReader({
      cache, servingVersion: 'v1', ttlMs: 1000, enabled: true, swr: { enabled: true, staleGraceMs: 60_000 },
    });
    let v = 1;
    const compute = vi.fn(async () => ({ value: v }));

    const a = await reader.read(BRAND_A, 'm', { p: 1 }, compute); // miss → stores value 1
    expect(a).toEqual({ value: 1 });
    expect(compute).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + 2_000); // +2s > 1s soft ttl → stale (but < grace, still present)
    v = 2;
    const b = await reader.read(BRAND_A, 'm', { p: 1 }, compute); // STALE served immediately
    expect(b).toEqual({ value: 1 }); // the last-known value, NOT blocked on a recompute
    await flush(); // let the background revalidation land
    expect(compute).toHaveBeenCalledTimes(2); // refreshed in the background

    const c = await reader.read(BRAND_A, 'm', { p: 1 }, compute); // fresh again (refreshed value)
    expect(c).toEqual({ value: 2 });
    expect(compute).toHaveBeenCalledTimes(2); // read c was a fresh hit, no new compute
  });

  it('stale serve emits result=stale (distinct from hit/miss)', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const cache = makeFakeCache();
    const reader = createServingCacheReader({
      cache, servingVersion: 'v1', ttlMs: 1000, enabled: true, swr: { enabled: true, staleGraceMs: 60_000 },
    });
    const results: string[] = [];
    const restore = setCounterSink({
      add: (name, _v, labels) => {
        if (name === 'serving_cache_requests_total') results.push(labels.result as string);
      },
    });
    try {
      await reader.read(BRAND_A, 'm', { p: 1 }, async () => 1); // miss
      nowSpy.mockReturnValue(1_000_000 + 2_000);
      await reader.read(BRAND_A, 'm', { p: 1 }, async () => 1); // stale
      await flush();
    } finally {
      restore();
    }
    expect(results).toEqual(['miss', 'stale']);
  });

  it('background revalidation failure keeps serving stale (no throw to the caller)', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = makeFakeCache();
    const reader = createServingCacheReader({
      cache, servingVersion: 'v1', ttlMs: 1000, enabled: true, swr: { enabled: true, staleGraceMs: 60_000 },
    });
    let fail = false;
    const compute = vi.fn(async () => {
      if (fail) throw new Error('Trino down mid-refresh');
      return { value: 1 };
    });
    await reader.read(BRAND_A, 'm', { p: 1 }, compute); // miss → value 1

    nowSpy.mockReturnValue(1_000_000 + 2_000);
    fail = true;
    const b = await reader.read(BRAND_A, 'm', { p: 1 }, compute); // stale served; background will fail
    expect(b).toEqual({ value: 1 }); // no throw — stale value returned
    await flush();

    const c = await reader.read(BRAND_A, 'm', { p: 1 }, compute); // still stale (refresh failed, value kept)
    expect(c).toEqual({ value: 1 });
  });
});
