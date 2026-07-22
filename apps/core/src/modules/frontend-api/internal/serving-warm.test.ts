/**
 * serving-warm.test.ts — ADR-0019 WS-4 D7 cluster-internal warm-on-write endpoint.
 *
 * Uses the REAL registerServingWarmRoute over a fake servingCache (records the (brand, metricId) it is
 * asked to prime) + a stub active-brand enumerator. The analytics compute closures are never actually
 * run — the fake cache short-circuits at the read() boundary — so this is a pure route/auth/allowlist
 * test with no DB. Proves:
 *   1. AUTH: no token configured → 404 (endpoint disabled — never an unauthenticated warm trigger),
 *   2. AUTH: wrong/absent x-internal-token → 401,
 *   3. token OK → iterates the FULL hot allowlist × active brands (identical metricIds), returns tallies,
 *   4. an explicit `datasets` subset + `brands` list narrows the grid,
 *   5. one failing (brand, dataset) read is counted + skipped, never aborts the sweep (fail-open leaf).
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServingCacheReader, SilverPool } from '@brain/metric-engine';
import type pg from 'pg';
import { registerServingWarmRoute, HOT_WARM_DATASETS, type ServingWarmDeps } from './serving-warm.js';

const BRAND_A = 'aaaa1111-0000-4000-8000-aaaaaaaaaaaa';
const BRAND_B = 'bbbb2222-0000-4000-8000-bbbbbbbbbbbb';
const TOKEN = 'warm-s3cr3t';

/** A servingCache that records each (brand, metricId) it is asked to prime and NEVER runs compute. */
function recordingCache(opts: { failOn?: (brand: string, metricId: string) => boolean } = {}): {
  cache: ServingCacheReader;
  reads: Array<{ brand: string; metricId: string }>;
} {
  const reads: Array<{ brand: string; metricId: string }> = [];
  const cache: ServingCacheReader = {
    async read<T>(brandId: string, metricId: string, _params: unknown, _compute: () => Promise<T>): Promise<T> {
      reads.push({ brand: brandId, metricId });
      if (opts.failOn?.(brandId, metricId)) throw new Error('compute blew up');
      return undefined as unknown as T; // primed the key; compute intentionally not run
    },
  };
  return { cache, reads };
}

async function buildApp(deps: Partial<ServingWarmDeps>): Promise<FastifyInstance> {
  const app = Fastify();
  registerServingWarmRoute(app, {
    // Every dataset guards on srPool OR rawPool being present — provide both as opaque truthy stubs so
    // warmOne reaches servingCache.read for all 8 datasets.
    srPool: {} as unknown as SilverPool,
    rawPool: {} as unknown as pg.Pool,
    listActiveBrandIds: async () => [BRAND_A, BRAND_B],
    ...deps,
  });
  await app.ready();
  return app;
}

describe('POST /internal/serving/warm (WS-4 D7)', () => {
  it('is DISABLED (404) when no service token is configured', async () => {
    const { cache } = recordingCache();
    const app = await buildApp({ servingCache: cache, warmToken: undefined });
    const res = await app.inject({ method: 'POST', url: '/internal/serving/warm', payload: {} });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a missing/wrong internal token with 401', async () => {
    const { cache, reads } = recordingCache();
    const app = await buildApp({ servingCache: cache, warmToken: TOKEN });
    const noHeader = await app.inject({ method: 'POST', url: '/internal/serving/warm', payload: {} });
    expect(noHeader.statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'POST',
      url: '/internal/serving/warm',
      headers: { 'x-internal-token': 'nope' },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
    expect(reads.length).toBe(0); // never warmed on an auth reject
    await app.close();
  });

  it('warms the FULL hot allowlist × active brands with matching metricIds', async () => {
    const { cache, reads } = recordingCache();
    const app = await buildApp({ servingCache: cache, warmToken: TOKEN });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/serving/warm',
      headers: { 'x-internal-token': TOKEN },
      payload: {}, // datasets + brands default to 'all'
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { warmed: number; failed: number; brands: number; datasets: number };
    expect(body.datasets).toBe(HOT_WARM_DATASETS.length);
    expect(body.brands).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.warmed).toBe(HOT_WARM_DATASETS.length * 2);
    // Every allowlist metricId was primed for both brands (the exact keys real requests hit).
    for (const brand of [BRAND_A, BRAND_B]) {
      for (const ds of HOT_WARM_DATASETS) {
        expect(reads).toContainEqual({ brand, metricId: ds });
      }
    }
    await app.close();
  });

  it('narrows the grid to an explicit datasets subset + brands list', async () => {
    const { cache, reads } = recordingCache();
    const app = await buildApp({ servingCache: cache, warmToken: TOKEN });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/serving/warm',
      headers: { 'x-internal-token': TOKEN },
      payload: { datasets: ['executive_metrics', 'kpi_summary', 'not_a_real_dataset'], brands: [BRAND_A] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { warmed: number; datasets: number; brands: number };
    expect(body.datasets).toBe(2); // junk dataset filtered out
    expect(body.brands).toBe(1);
    expect(body.warmed).toBe(2);
    expect(reads).toEqual([
      { brand: BRAND_A, metricId: 'executive_metrics' },
      { brand: BRAND_A, metricId: 'kpi_summary' },
    ]);
    await app.close();
  });

  it('counts + skips a failing (brand, dataset) read — one bad read never aborts the sweep', async () => {
    const { cache, reads } = recordingCache({
      failOn: (brand, metricId) => brand === BRAND_A && metricId === 'orders_list',
    });
    const app = await buildApp({ servingCache: cache, warmToken: TOKEN });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/serving/warm',
      headers: { 'x-internal-token': TOKEN },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { warmed: number; failed: number };
    expect(body.failed).toBe(1);
    expect(body.warmed).toBe(HOT_WARM_DATASETS.length * 2 - 1);
    // The sweep continued past the failure: BRAND_B's orders_list still got primed.
    expect(reads).toContainEqual({ brand: BRAND_B, metricId: 'orders_list' });
    await app.close();
  });
});
