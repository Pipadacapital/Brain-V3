/**
 * silver-reader.test.ts — the serving-pool plumbing of createSilverReader.
 * Proves: (1) queryTimeoutMs flows into the duckdb-serving adapter with a client fetch abort
 * derived to OUTLIVE the server watchdog (+10s — server 504s first, never an opaque abort);
 * (2) omitting it keeps the adapter's own OLTP defaults (no accidental override);
 * (3) the ${BRAND_PREDICATE} fail-closed guard still refuses un-scoped SQL.
 *
 * Regression anchor: the silver-identity stall (stuck watermark since 2026-07-14) — the identity
 * lane's keystone reads exceeded the 25s OLTP default and the raised budget was silently dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createDuckDbServingPool = vi.fn(() => ({ query: vi.fn(async () => []) }));
vi.mock('@brain/metric-engine', () => ({
  createDuckDbServingPool: (...args: unknown[]) => createDuckDbServingPool(...(args as [])),
}));

import { createSilverReader, BRAND_PREDICATE } from './silver-reader.js';

beforeEach(() => {
  createDuckDbServingPool.mockClear();
});

describe('createSilverReader — serving-pool timeout plumbing', () => {
  it('passes queryTimeoutMs and derives fetchTimeoutMs = queryTimeoutMs + 10s', () => {
    createSilverReader({ baseUrl: 'http://serving:8091', queryTimeoutMs: 120_000 });
    expect(createDuckDbServingPool).toHaveBeenCalledWith({
      baseUrl: 'http://serving:8091',
      queryTimeoutMs: 120_000,
      fetchTimeoutMs: 130_000,
    });
  });

  it('omits both knobs when queryTimeoutMs is not configured (adapter defaults apply)', () => {
    createSilverReader({ baseUrl: 'http://serving:8091' });
    expect(createDuckDbServingPool).toHaveBeenCalledWith({ baseUrl: 'http://serving:8091' });
  });

  it('scopedQuery still fails closed on SQL missing the brand-predicate sentinel', async () => {
    const reader = createSilverReader({ baseUrl: 'http://serving:8091', queryTimeoutMs: 120_000 });
    await expect(reader.scopedQuery('brand-1', 'SELECT 1')).rejects.toThrow(/BRAND_PREDICATE/);
    // and the sentinel-carrying shape is accepted (delegates to the pool)
    await expect(
      reader.scopedQuery('brand-1', `SELECT 1 WHERE ${BRAND_PREDICATE}`),
    ).resolves.toEqual([]);
  });
});
