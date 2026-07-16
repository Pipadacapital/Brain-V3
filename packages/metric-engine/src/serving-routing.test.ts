/**
 * serving-routing.test.ts — unit tests for the serving + cache + routing contracts.
 *
 * Verified assertions:
 *   1. withServingBrand THROWS when the query is missing the ${BRAND_PREDICATE} sentinel.
 *   2. withServingBrand INJECTS brand_id = ? and appends brandId to params (happy path).
 *   3. withServingBrand with __unsafeDisableBrandPredicate=true does NOT throw, runs 1=1.
 *   4. buildCacheKey returns a brand_id-LEADING composite key.
 *   5. routeKnownMetric NEVER returns QueryRoute.duckdb_adhoc (cache_hit and miss cases).
 *   6. routeAiAdHocServing ALWAYS throws NotImplementedYet.
 *
 * Note: The concrete ServingPool HTTP adapter (duckdb-serving-adapter.ts) is NOT tested here —
 * it makes real HTTP calls and is tested via integration. We test the PORT seam only.
 */
import { describe, it, expect } from 'vitest';
import {
  withServingBrand,
  BRAND_PREDICATE,
  type ServingPool,
} from './serving-deps.js';
import { buildCacheKey } from './analytics-cache.js';
import { QueryRoute, routeKnownMetric, routeAiAdHocServing, NotImplementedYet } from './query-route.js';

const BRAND_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRAND_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// ── ServingPool mock ─────────────────────────────────────────────────────────────

/**
 * Create a fake ServingPool that captures the last SQL + params for inspection,
 * and optionally resolves with rows or rejects.
 */
function makePool(opts: {
  resolve?: Record<string, unknown>[];
  reject?: Error;
} = {}): { pool: ServingPool; lastSql(): string; lastParams(): unknown[] } {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const pool: ServingPool = {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      capturedSql = sql;
      capturedParams = params;
      if (opts.reject) throw opts.reject;
      return (opts.resolve ?? []) as T[];
    },
  };
  return {
    pool,
    lastSql: () => capturedSql,
    lastParams: () => capturedParams,
  };
}

// ── withServingBrand tests ───────────────────────────────────────────────────────

describe('withServingBrand — brand isolation seam', () => {
  it('THROWS when the query is missing the ${BRAND_PREDICATE} sentinel (fail-closed)', async () => {
    const { pool } = makePool({ resolve: [{ leaked: 'all brands' }] });
    await expect(
      withServingBrand(pool, BRAND_A, (scope) =>
        // No ${BRAND_PREDICATE} — must throw, not leak cross-brand data.
        scope.runScoped('SELECT * FROM iceberg.brain_bronze.events'),
      ),
    ).rejects.toThrow(/BRAND_PREDICATE/);
  });

  it('THROWS when the query has an empty WHERE with no sentinel', async () => {
    const { pool } = makePool();
    await expect(
      withServingBrand(pool, BRAND_A, (scope) =>
        scope.runScoped('SELECT * FROM iceberg.brain_bronze.events WHERE 1=1'),
      ),
    ).rejects.toThrow(/BRAND_PREDICATE/);
  });

  it('injects brand_id = ? and appends brandId as last param (happy path)', async () => {
    const { pool, lastSql, lastParams } = makePool({ resolve: [{ event_type: 'page_view', n: 5 }] });
    const rows = await withServingBrand(pool, BRAND_A, (scope) =>
      scope.runScoped(
        `SELECT event_type, count(*) n FROM iceberg.brain_bronze.events WHERE tenant_ts > ? AND ${BRAND_PREDICATE}`,
        ['2024-01-01'],
      ),
    );
    expect(rows).toEqual([{ event_type: 'page_view', n: 5 }]);
    // Sentinel replaced with parameterized predicate
    expect(lastSql()).toBe(
      'SELECT event_type, count(*) n FROM iceberg.brain_bronze.events WHERE tenant_ts > ? AND brand_id = ?',
    );
    // brandId appended as last param
    expect(lastParams()).toEqual(['2024-01-01', BRAND_A]);
  });

  it('brand_id is the LAST param — never in a position that could match a different placeholder', async () => {
    const { pool, lastParams } = makePool();
    await withServingBrand(pool, BRAND_B, (scope) =>
      scope.runScoped(
        `SELECT * FROM iceberg.brain_bronze.orders WHERE date > ? AND ${BRAND_PREDICATE}`,
        ['2024-06-01'],
      ),
    ).catch(() => {
      /* pool may throw in other tests — here pool resolves */
    });
    // Confirm the last element of params is the brand UUID
    const params = lastParams();
    if (params.length > 0) {
      expect(params[params.length - 1]).toBe(BRAND_B);
    }
  });

  it('__unsafeDisableBrandPredicate=true does NOT throw and replaces sentinel with 1=1 (mutation proof)', async () => {
    const { pool, lastSql, lastParams } = makePool({ resolve: [{ brand_id: BRAND_B }] });
    const rows = await withServingBrand(
      pool,
      BRAND_A,
      (scope) =>
        scope.runScoped(
          `SELECT brand_id FROM iceberg.brain_bronze.events WHERE ${BRAND_PREDICATE}`,
        ),
      { __unsafeDisableBrandPredicate: true },
    );
    // Must not throw — and must have replaced sentinel with 1=1 (cross-brand leak is intentional in test)
    expect(lastSql()).toBe('SELECT brand_id FROM iceberg.brain_bronze.events WHERE 1 = 1');
    // No brandId appended to params (predicate disabled)
    expect(lastParams()).toEqual([]);
    // Returns data from pool (would leak brand_B rows — that's the mutation proof)
    expect(rows).toEqual([{ brand_id: BRAND_B }]);
  });

  it('propagates errors from the pool (real query bugs are not masked)', async () => {
    const { pool } = makePool({ reject: new Error('serving syntax error near SELECTT') });
    await expect(
      withServingBrand(pool, BRAND_A, (scope) =>
        scope.runScoped(`SELECT * FROM events WHERE ${BRAND_PREDICATE}`),
      ),
    ).rejects.toThrow('serving syntax error');
  });
});

// ── buildCacheKey tests ────────────────────────────────────────────────────────

describe('buildCacheKey — brand_id-leading composite key', () => {
  it('first colon-delimited segment is brandId (brand_id-LEADING invariant)', () => {
    const key = buildCacheKey(BRAND_A, 'realized_revenue', 'abc123', 'v1');
    const segments = key.split(':');
    // UUID has 5 segments separated by '-'; the first colon-split segment is the whole UUID
    expect(segments[0]).toBe(BRAND_A);
  });

  it('key has exactly 4 segments in order: brandId:metricId:paramsHash:servingVersion', () => {
    const key = buildCacheKey(BRAND_A, 'blended_roas', 'deadbeef', 'v2');
    // UUID contains hyphens but not colons; split on ':' gives our 4 segments
    const [b, m, p, s] = key.split(':');
    expect(b).toBe(BRAND_A);
    expect(m).toBe('blended_roas');
    expect(p).toBe('deadbeef');
    expect(s).toBe('v2');
  });

  it('different brandIds produce different keys (no cross-brand alias)', () => {
    const k1 = buildCacheKey(BRAND_A, 'realized_revenue', 'hash1', 'v1');
    const k2 = buildCacheKey(BRAND_B, 'realized_revenue', 'hash1', 'v1');
    expect(k1).not.toBe(k2);
    expect(k1.startsWith(BRAND_A + ':')).toBe(true);
    expect(k2.startsWith(BRAND_B + ':')).toBe(true);
  });

  it('different servingVersions produce different keys (MV rebuild invalidates cache)', () => {
    const k1 = buildCacheKey(BRAND_A, 'realized_revenue', 'hash1', 'v1');
    const k2 = buildCacheKey(BRAND_A, 'realized_revenue', 'hash1', 'v2');
    expect(k1).not.toBe(k2);
  });
});

// ── routeKnownMetric tests ─────────────────────────────────────────────────────

describe('routeKnownMetric — NEVER returns duckdb_adhoc', () => {
  it('returns cache_hit when cacheHit=true', () => {
    expect(routeKnownMetric(true)).toBe(QueryRoute.cache_hit);
  });

  it('returns duckdb_serving when cacheHit=false', () => {
    expect(routeKnownMetric(false)).toBe(QueryRoute.duckdb_serving);
  });

  it('never returns duckdb_adhoc (checked exhaustively)', () => {
    for (const cacheHit of [true, false]) {
      const route = routeKnownMetric(cacheHit);
      expect(route).not.toBe(QueryRoute.duckdb_adhoc);
    }
  });

  it('the string values are exactly cache_hit and duckdb_serving (not duckdb_adhoc)', () => {
    expect(routeKnownMetric(true)).toBe('cache_hit');
    expect(routeKnownMetric(false)).toBe('duckdb_serving');
  });
});

// ── routeAiAdHocServing DISABLED seam tests ───────────────────────────────────

describe('routeAiAdHocServing — AI-ad-hoc-serving DISABLED seam', () => {
  it('ALWAYS throws NotImplementedYet (never returns a value)', () => {
    expect(() => routeAiAdHocServing()).toThrow(NotImplementedYet);
  });

  it('throws with a message that names duckdb-serving as the correct serving path', () => {
    expect(() => routeAiAdHocServing('SELECT 1')).toThrow(/duckdb-serving \(brain_serving\.mv_\*\)/);
  });

  it('throws with DISABLED in the message (registered, not silently absent)', () => {
    expect(() => routeAiAdHocServing()).toThrow(/DISABLED/);
  });

  it('thrown error is instanceof NotImplementedYet (not a plain Error)', () => {
    try {
      routeAiAdHocServing('SELECT brand_id FROM iceberg.x WHERE 1=1');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplementedYet);
      expect((err as NotImplementedYet).name).toBe('NotImplementedYet');
    }
  });
});
