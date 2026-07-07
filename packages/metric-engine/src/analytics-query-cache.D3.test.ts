// SPEC: D.3 / §1.11.2
/**
 * BAI query-result cache key `{brand_id}:q:{normalized_query_hash}` — §1.11.2.
 *
 * The natural-language / structured BAI ask path has a QUERY, not a (metricId, params) tuple, so it
 * needs its own cache seam. §1.11.2 pins the shape: brand_id-LEADING (isolation invariant + the same
 * `${brandId}:*` SCAN invalidation the crypto-shred cache-bust uses), a `q` namespace segment
 * disjoint from the metric-serving keyspace, and a NORMALIZED query hash so two asks that differ only
 * in case / whitespace share one cached answer. These tests pin exactly that.
 */

import { describe, it, expect } from 'vitest';
import { buildQueryCacheKey, normalizeQuery, hashQuery, buildCacheKey } from './analytics-cache.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

describe('D3 / §1.11.2 — BAI query-result cache key', () => {
  it('key is brand_id-LEADING with a `q` namespace segment', () => {
    const key = buildQueryCacheKey(BRAND, 'revenue last 7 days');
    expect(key.startsWith(`${BRAND}:q:`)).toBe(true);
    // brand_id-leading → the same `${brandId}:*` SCAN invalidation (crypto-shred cache bust) covers it.
    expect(key.split(':')[0]).toBe(BRAND);
    expect(key.split(':')[1]).toBe('q');
  });

  it('normalizes case + whitespace so semantically-identical asks share ONE answer', () => {
    expect(normalizeQuery('  Revenue   Last 7 Days ')).toBe('revenue last 7 days');
    expect(buildQueryCacheKey(BRAND, '  Revenue   Last 7 Days ')).toBe(
      buildQueryCacheKey(BRAND, 'revenue last 7 days'),
    );
    expect(hashQuery('Revenue Last 7 Days')).toBe(hashQuery('revenue last 7 days'));
  });

  it('distinct queries → distinct keys (no collision for genuinely different asks)', () => {
    expect(buildQueryCacheKey(BRAND, 'revenue last 7 days')).not.toBe(
      buildQueryCacheKey(BRAND, 'orders last 7 days'),
    );
  });

  it('same query under DIFFERENT brands → different keys (tenant isolation in the key)', () => {
    expect(buildQueryCacheKey(BRAND, 'revenue last 7 days')).not.toBe(
      buildQueryCacheKey(OTHER, 'revenue last 7 days'),
    );
  });

  it('the `q` keyspace is DISJOINT from the metric-serving keyspace (no cross-namespace clash)', () => {
    // metric-serving keys are `${brand}:${metricId}:...`; a metricId of 'q' would still differ because
    // the query key's segment-3 is a hash, and the metric key carries paramsHash + servingVersion.
    const queryKey = buildQueryCacheKey(BRAND, 'anything');
    const metricKey = buildCacheKey(BRAND, 'realized_revenue', 'ph', 'v1');
    expect(queryKey).not.toBe(metricKey);
    expect(metricKey.split(':')[1]).not.toBe('q'); // metric keyspace never uses the `q` segment
  });

  it('hash is stable + fixed-width (deterministic key length)', () => {
    const h = hashQuery('revenue last 7 days');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashQuery('revenue last 7 days')).toBe(h); // deterministic across calls
  });
});
