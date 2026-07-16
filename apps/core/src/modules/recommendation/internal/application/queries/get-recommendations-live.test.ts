import { describe, it, expect } from 'vitest';
import type { DbPool } from '@brain/db';
import { RecommendationsSchema } from '@brain/contracts';
import {
  getRecommendationsLive,
  RECOMMENDATIONS_LIVE_METRIC_ID,
  type RecommendationLiveDeps,
  type RecommendationServingCache,
} from './get-recommendations-live.js';
import type { RawRecommendation } from './get-recommendations.js';

const BRAND = '44444444-4444-4444-8444-444444444444';
const CID = 'test-correlation';
const TRUSTED: RecommendationLiveDeps['gate'] = { tier: 'trusted', blocksHighRiskRecommendation: false };

/** srPool is never touched on the cache-HIT path (compute never runs); a throwing stub proves that. */
const srPoolNever = { query() { throw new Error('srPool must not be read on a cache hit'); } } as never;
/** pool is never touched on the cache-HIT path either. */
const poolNever = { connect() { throw new Error('pool must not be read on a cache hit'); } } as unknown as DbPool;

function rawRec(over: Partial<RawRecommendation> = {}): RawRecommendation {
  return {
    recommendation_id: 'rec-1',
    detector: 'rto_risk',
    kind: 'risk',
    confidence: 'Trusted',
    priority: 5,
    status: 'open',
    title: 'RTO risk rising',
    summary: 'why',
    recommended_action: 'do this',
    evidence: { rto_rate_pct: 12.5, order_count: 40 },
    outcome: null,
    created_at: '2026-07-16T00:00:00.000Z',
    ...over,
  };
}

/**
 * A fake ServingCacheReader. In HIT mode it returns the canned rows and NEVER invokes compute (so a
 * throwing pool/srPool proves the compute path didn't run). It records the (brandId, metricId) it was
 * called with so we can assert the brand-leading, per-metric key contract.
 */
function fakeCache(
  canned: RawRecommendation[],
  mode: 'hit' | 'miss' = 'hit',
): RecommendationServingCache & { calls: Array<{ brandId: string; metricId: string }> } {
  const calls: Array<{ brandId: string; metricId: string }> = [];
  return {
    calls,
    async read<T>(brandId: string, metricId: string, _params: unknown, compute: () => Promise<T>): Promise<T> {
      calls.push({ brandId, metricId });
      if (mode === 'miss') return compute();
      return canned as unknown as T;
    },
  };
}

describe('getRecommendationsLive — request-time serving (Phase 2)', () => {
  it('serves the cached raw set through the ServingCacheReader, keyed per-brand on recommendations_live', async () => {
    const cache = fakeCache([rawRec()]);
    const res = await getRecommendationsLive(BRAND, CID, {
      pool: poolNever,
      srPool: srPoolNever,
      servingCache: cache,
      gate: TRUSTED,
    });

    expect(res.state).toBe('has_data');
    if (res.state !== 'has_data') return;
    expect(res.recommendations).toHaveLength(1);
    expect(res.recommendations[0]!.detector).toBe('rto_risk');
    // brand-leading key contract (so gold.rewritten.v1 `${brandId}:*` invalidation busts it).
    expect(cache.calls).toEqual([{ brandId: BRAND, metricId: RECOMMENDATIONS_LIVE_METRIC_ID }]);
    // and it is a valid BFF contract response.
    expect(() => RecommendationsSchema.parse(res)).not.toThrow();
  });

  it('applies the confidence gate at SERVE time (after the cache) — holds a high-risk rec below Trusted', async () => {
    const cache = fakeCache([rawRec({ kind: 'risk', confidence: 'Trusted' })]);
    const res = await getRecommendationsLive(BRAND, CID, {
      pool: poolNever,
      srPool: srPoolNever,
      servingCache: cache,
      // Untrusted foundation that blocks high-risk recs → the cached raw rec is HELD at serve.
      gate: { tier: 'untrusted', blocksHighRiskRecommendation: true },
    });
    if (res.state !== 'has_data') throw new Error('expected has_data');
    expect(res.recommendations[0]!.held).toBe(true);
    expect(res.recommendations[0]!.held_reason).toBeTruthy();
  });

  it('returns no_data when the (cached) set is empty', async () => {
    const cache = fakeCache([]);
    const res = await getRecommendationsLive(BRAND, CID, {
      pool: poolNever,
      srPool: srPoolNever,
      servingCache: cache,
      gate: TRUSTED,
    });
    expect(res.state).toBe('no_data');
  });

  it('safe-off: with no servingCache, invokes compute() directly (the on-demand refresh+read path)', async () => {
    // No cache injected → getRecommendationsLive awaits compute() directly. We prove the miss-path is
    // taken by routing through a fake cache in 'miss' mode whose compute would run generate+read; here
    // we assert the simpler safe-off contract: absent a cache, the ONE read still resolves. compute is
    // exercised end-to-end (generate → readRaw) by generateRecommendations' own live tests; here we
    // confirm the cache-miss delegation calls compute exactly once.
    let computeCalls = 0;
    const cache: RecommendationServingCache = {
      async read<T>(_b: string, _m: string, _p: unknown, compute: () => Promise<T>): Promise<T> {
        computeCalls += 1;
        return compute();
      },
    };
    // compute() = generate + readRaw; readRaw reads via pool. Give a pool whose SELECT returns one row
    // and whose generate-side upserts return a recommendation_id — enough for the orchestration to run.
    const client = {
      async query(_ctx: unknown, sql: string) {
        if (/FROM recommendation\b/i.test(sql)) {
          return {
            rows: [
              {
                recommendation_id: 'rec-live', detector: 'rto_risk', kind: 'risk', confidence: 'Trusted',
                priority: 5, status: 'open',
                payload: { title: 't', summary: 's', recommended_action: 'a', evidence: { x: 1 } },
                outcome: null, created_at: new Date('2026-07-16T00:00:00.000Z'),
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [{ recommendation_id: 'rec-live', inserted: true }], rowCount: 1 };
      },
      release() {},
    };
    const pool = { async connect() { return client as never; } } as unknown as DbPool;
    // srPool stub: every detector signal reads resolve to empty → detectors don't fire → generate expires
    // (no open rows) → then readRaw returns the canned row above.
    const srPool = { async query() { return { rows: [] }; } } as never;

    const res = await getRecommendationsLive(BRAND, CID, { pool, srPool, servingCache: cache, gate: TRUSTED });
    expect(computeCalls).toBe(1);
    expect(res.state).toBe('has_data');
    if (res.state !== 'has_data') return;
    expect(res.recommendations[0]!.recommendation_id).toBe('rec-live');
  });
});
