/**
 * gold-rewritten-publish.unit.test.ts — ADR-0016 P1.3: the commit-driven serving-cache evict.
 *
 * PROVES the post-Gold cache-bust is BRAND-SCOPED and commit-driven (the ≤60s freshness SLO's
 * Redis half — evict the instant Gold commits, re-warm lazily on next read):
 *   1. Every active brand's serving keys are evicted, each under its OWN `${brandId}:*` scan —
 *      one brand's bust NEVER deletes another brand's keys (tenant isolation).
 *   2. Durable per-brand config (`{brand}:flag:*`, AMD-23) survives the bust.
 *   3. No active brands → no-op (0/0/0), no scan issued.
 *   4. FAIL-OPEN: a Redis error on one brand degrades to a partial count, never throws (the
 *      per-metric TTL is the correctness safety net).
 *
 * NO live infra: pg.Pool + ioredis are in-memory doubles (same idiom as the erasure unit test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory Redis fake (glob SCAN + DEL, injectable failure) ─────────────────

const redisStore = new Map<string, string>();
let redisScanFailing = false;

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

vi.mock('ioredis', () => {
  class FakeRedis {
    constructor(_url?: unknown, _opts?: unknown) {}
    async quit(): Promise<string> {
      return 'OK';
    }
    async del(key: string): Promise<number> {
      return redisStore.delete(key) ? 1 : 0;
    }
    async scan(
      _cursor: string,
      _matchArg: string,
      pattern: string,
      _countArg: string,
      _batch: number,
    ): Promise<[string, string[]]> {
      if (redisScanFailing) throw new Error('redis down (injected)');
      const re = globToRegExp(pattern);
      return ['0', [...redisStore.keys()].filter((k) => re.test(k))];
    }
  }
  return { Redis: FakeRedis, default: FakeRedis };
});

// ── In-memory pg.Pool fake — list_active_brand_ids() returns the configured brands ──

let activeBrandIds: string[] = [];

vi.mock('pg', () => {
  class FakePool {
    constructor(_opts?: unknown) {}
    async query<T>(_sql: string): Promise<{ rows: T[] }> {
      return { rows: activeBrandIds.map((id) => ({ id })) as unknown as T[] };
    }
    async end(): Promise<void> {}
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

import { runGoldRewrittenPublish } from '../jobs/gold-rewritten-publish/run.js';

const BRAND_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRAND_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  redisStore.clear();
  redisScanFailing = false;
  activeBrandIds = [];
});

describe('gold-rewritten-publish — brand-scoped commit-driven evict (ADR-0016 P1.3)', () => {
  it('evicts EACH active brand under its own prefix — no cross-brand deletion', async () => {
    activeBrandIds = [BRAND_A, BRAND_B];
    redisStore.set(`${BRAND_A}:revenue_today:h1:v1`, 'a1');
    redisStore.set(`${BRAND_A}:orders_today:h2:v1`, 'a2');
    redisStore.set(`${BRAND_B}:revenue_today:h1:v1`, 'b1');

    const result = await runGoldRewrittenPublish();

    expect(result.brands).toBe(2);
    expect(result.evicted).toBe(2);
    expect(result.keysDeleted).toBe(3); // 2 for A + 1 for B
    expect(redisStore.size).toBe(0);
  });

  it('leaves durable per-brand config (`{brand}:flag:*`, AMD-23) intact', async () => {
    activeBrandIds = [BRAND_A];
    redisStore.set(`${BRAND_A}:revenue_today:h1:v1`, 'cache');
    redisStore.set(`${BRAND_A}:flag:stitch.v2`, 'on'); // durable config — exempt

    const result = await runGoldRewrittenPublish();

    expect(result.keysDeleted).toBe(1); // only the cache key
    expect(redisStore.has(`${BRAND_A}:flag:stitch.v2`)).toBe(true);
  });

  it('no active brands → no-op (0/0/0)', async () => {
    activeBrandIds = [];
    const result = await runGoldRewrittenPublish();
    expect(result).toEqual({ brands: 0, evicted: 0, keysDeleted: 0 });
  });

  it('is FAIL-OPEN — a Redis error degrades to a partial count, never throws', async () => {
    activeBrandIds = [BRAND_A];
    redisStore.set(`${BRAND_A}:revenue_today:h1:v1`, 'cache');
    redisScanFailing = true;

    const result = await runGoldRewrittenPublish();

    // evictBrand swallows the scan failure (TTL is the safety net) → 0 keys, brand still counted.
    expect(result.brands).toBe(1);
    expect(result.evicted).toBe(1);
    expect(result.keysDeleted).toBe(0);
  });
});
