/**
 * getRecommendationsLive — Phase 2: REQUEST-TIME recommendation serving.
 *
 * The stored path (getRecommendations) reads whatever the batch `recommendation-detectors` cron last
 * persisted — so a rec is only as fresh as the last cron tick. This path computes the detector set at
 * REQUEST time against the freshest Silver/Gold (duckdb-serving), Redis-caches it, and lets a Gold rewrite bust
 * the cache — so a request reflects the medallion as of ~now, not the last cron.
 *
 * HOW IT STAYS CHEAP AND CORRECT:
 *   - Fronted by the ServingCacheReader (structural dep): brand-leading key, TTL, stampede-guarded
 *     getOrSet, fail-soft. So the expensive compute (4 detectors × serving reads) runs at most ONCE per
 *     brand per invalidation window; concurrent requests share the in-flight compute.
 *   - Event-driven invalidation is FREE: the cache key leads with brand_id, and the existing
 *     AnalyticsCacheInvalidateConsumer busts `${brandId}:*` on gold.rewritten.v1 — so the moment a
 *     brand's Gold marts are rewritten (every ~5 min under realtime Phase 1), the next request
 *     recomputes.
 *   - compute() reuses generateRecommendations (idempotent upsert + append-only decision_log), so the
 *     persisted set + audit trail + outcome-measurement inputs stay intact — the request-time path is a
 *     fresh REFRESH, not a parallel unpersisted computation.
 *   - The confidence gate is applied AFTER the cache, against CURRENT trust, so a trust change reflects
 *     immediately without a cache bust (only the raw detector findings are cached).
 *
 * SAFE-OFF: no servingCache injected (or the route flag off) → compute() runs directly (no cache), i.e.
 * an on-demand refresh + read. The route gates this behind `recommendations.request_time` (default OFF),
 * falling back to the stored getRecommendations.
 */

import type { DbPool } from '@brain/db';
// WA-02: metric-engine is fenced to the measurement tier — consume via the analytics facade.
import type { SilverPool } from '../../../../analytics/index.js';
import type { ConfidenceGateInputs } from '../../domain/confidence-gate.js';
import { generateRecommendations } from '../generate-recommendations.js';
import {
  applyGateToRawRecs,
  readOpenRecommendationsRaw,
  type RawRecommendation,
  type Recommendations,
} from './get-recommendations.js';

/**
 * The single method this path needs from the ServingCacheReader — typed structurally so the
 * recommendation module does not import @brain/metric-engine directly (WA-02 fence). The route passes
 * the real ServingCacheReader, which satisfies this shape.
 */
export interface RecommendationServingCache {
  read<T>(brandId: string, metricId: string, params: unknown, compute: () => Promise<T>): Promise<T>;
}

export interface RecommendationLiveDeps {
  pool: DbPool;
  /** Trino Silver/Gold serving pool — the detectors' fresh-signal source. */
  srPool: SilverPool;
  /** Redis serving cache. Omit → direct compute (safe-off). */
  servingCache?: RecommendationServingCache;
  /** The brand's CURRENT trust gate — applied at serve time, after the cache. */
  gate: ConfidenceGateInputs;
}

/** The cache-key id for a brand's request-time recommendation set (params are empty — purely per-brand). */
export const RECOMMENDATIONS_LIVE_METRIC_ID = 'recommendations_live';

export async function getRecommendationsLive(
  brandId: string,
  correlationId: string,
  deps: RecommendationLiveDeps,
): Promise<Recommendations> {
  // The miss path: refresh the detectors against fresh Silver/Gold, then read the fresh raw set.
  const compute = async (): Promise<RawRecommendation[]> => {
    await generateRecommendations(brandId, correlationId, { pool: deps.pool, srPool: deps.srPool });
    return readOpenRecommendationsRaw(brandId, correlationId, deps.pool);
  };

  const raw = deps.servingCache
    ? await deps.servingCache.read(brandId, RECOMMENDATIONS_LIVE_METRIC_ID, {}, compute)
    : await compute();

  if (raw.length === 0) {
    return { state: 'no_data' };
  }
  return { state: 'has_data', recommendations: applyGateToRawRecs(raw, deps.gate) };
}
