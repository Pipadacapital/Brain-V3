/**
 * @brain/metric-engine — ServingCacheReader (Redis-fronted hot serving reads).
 *
 * Brain V4 serves KNOWN registered metrics from brain_serving.mv_* over TRINO (Iceberg).
 * This thin reader fronts those hot reads with the AnalyticsCachePort (Redis) so a repeat
 * read of the same (brand, metric, params, serving-version) is served from cache instead
 * of re-hitting Trino. It is the SINGLE chokepoint the BFF metric-compute path wraps —
 * the ~49 metric compute functions and the withSilverBrand seam are UNCHANGED.
 *
 * ── KEY FORMAT (brand_id-LEADING) ─────────────────────────────────────────────
 * Keys are built with buildCacheKey → `${brandId}:${metricId}:${paramsHash}:${servingVersion}`.
 * brand_id leads so the AnalyticsCacheInvalidateConsumer can bust a brand's keys with a
 * `${brandId}:*` SCAN, and any cross-brand leak is detectable from the key alone.
 *
 * ── FLAG GATE + SAFE-OFF FALLBACK ─────────────────────────────────────────────
 * When `enabled` is false the reader is a pass-through: it calls `compute()` directly
 * (read Trino, no cache). Defaults are resolved at the composition root (ON in prod).
 *
 * ── FAIL-SOFT (never break a read because of the cache) ───────────────────────
 * The happy path uses the cache port's stampede-guarded getOrSet. If the CACHE layer
 * errors (Redis down on the get, or the set fails after a successful compute) the read
 * still succeeds:
 *   • cache GET fails before compute ran  → fall back to a direct compute() (Trino).
 *   • compute() (Trino) itself throws     → the real read error PROPAGATES (never swallowed,
 *                                            never retried — no double Trino query).
 *   • compute() ok but cache SET fails     → return the computed value (drop the cache write).
 *
 * @see packages/metric-engine/src/analytics-cache.ts — AnalyticsCachePort + buildCacheKey + getOrSet
 * @see packages/metric-engine/src/silver-deps.ts      — the Trino serving seam the compute closures use
 * @see apps/stream-worker/.../AnalyticsCacheInvalidateConsumer.ts — the brand-leading key buster
 */

import { createHash } from 'node:crypto';
import { incrementCounter } from '@brain/observability';
import { type AnalyticsCachePort, buildCacheKey } from './analytics-cache.js';
import { resolveServingTtlMs } from './serving-ttl.js';

/**
 * serving_cache_requests_total{result, metric_id} — the hit-rate signal.
 *   result=hit   → served from Redis (compute closure never ran).
 *   result=miss  → cache miss; computed via Trino and (attempted to) cache-fill.
 *   result=bypass→ flag disabled; read Trino directly, cache untouched.
 *   result=error → cache layer errored; served via fail-soft direct read (NOT counted as hit/miss
 *                  so the ratio hit/(hit+miss) stays a clean cache-effectiveness number).
 * metric_id is bounded (~49 registered metrics) → safe label cardinality.
 * Hit rate = rate(...{result="hit"}) / rate(...{result=~"hit|miss"}).
 */
function recordCacheResult(result: 'hit' | 'miss' | 'bypass' | 'error', metricId: string): void {
  incrementCounter('serving_cache_requests_total', { result, metric_id: metricId });
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface ServingCacheReaderConfig {
  /** The shared analytics cache (IoredisCacheAdapter over the single core Redis client). */
  readonly cache: AnalyticsCachePort;
  /** Serving materialization version — the trailing cache-key segment (e.g. 'v1'). */
  readonly servingVersion: string;
  /**
   * DEFAULT TTL (ms) for cached serving reads. A metric mapped to a freshness tier in
   * METRIC_TTL_TIER uses its tier TTL instead (resolveServingTtlMs); unmapped metrics
   * use this value — the historical single-global-TTL behavior.
   */
  readonly ttlMs: number;
  /** Flag gate. false → pass-through (compute() directly; no cache touched). */
  readonly enabled: boolean;
}

export interface ServingCacheReader {
  /**
   * Read a known metric through the cache.
   *
   * @param brandId  - brand UUID (leads the cache key — isolation invariant).
   * @param metricId - the registered metric id (stable per route/metric).
   * @param params   - the query params (hashed into the key; order-insensitive for objects).
   * @param compute  - the actual Trino read (the withSilverBrand closure). Invoked on a miss.
   */
  read<T>(brandId: string, metricId: string, params: unknown, compute: () => Promise<T>): Promise<T>;
}

// ── Stable params hash ────────────────────────────────────────────────────────

/**
 * Canonicalize a value to a deterministic JSON string (object keys sorted recursively)
 * so that `{from,to}` and `{to,from}` hash identically. Dates → ISO; bigint → string.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

/** Stable, collision-resistant hash of the query params for the cache key. */
export function hashParams(params: unknown): string {
  const canonical = JSON.stringify(canonicalize(params));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a ServingCacheReader. Inject at the composition root; pass to the BFF metric
 * routes. When `enabled` is false the returned reader is a pure pass-through.
 */
export function createServingCacheReader(config: ServingCacheReaderConfig): ServingCacheReader {
  const { cache, servingVersion, ttlMs, enabled } = config;

  return {
    async read<T>(
      brandId: string,
      metricId: string,
      params: unknown,
      compute: () => Promise<T>,
    ): Promise<T> {
      // Safe-OFF fallback: flag disabled → read Trino directly, never touch the cache.
      if (!enabled) {
        recordCacheResult('bypass', metricId);
        return compute();
      }

      const key = buildCacheKey(brandId, metricId, hashParams(params), servingVersion);

      // Track whether the compute closure ran and how it resolved, so we can tell a CACHE
      // error apart from a real compute error inside getOrSet (which folds both into one promise).
      // Held in an object so TS does not narrow the literal across the getOrSet closure boundary.
      const state: { outcome: 'pending' | 'ok' | 'failed'; value?: T } = { outcome: 'pending' };
      const guardedCompute = async (): Promise<T> => {
        try {
          const v = await compute();
          state.outcome = 'ok';
          state.value = v;
          return v;
        } catch (err) {
          state.outcome = 'failed';
          throw err;
        }
      };

      try {
        const value = await cache.getOrSet<T>(key, guardedCompute, resolveServingTtlMs(metricId, ttlMs));
        // Clean success: outcome tells hit from miss. 'pending' → the compute closure never ran →
        // the value came straight from Redis (HIT). 'ok' → compute ran and cache-filled (MISS).
        recordCacheResult(state.outcome === 'pending' ? 'hit' : 'miss', metricId);
        return value;
      } catch (err) {
        if (state.outcome === 'failed') {
          // The Trino read itself failed — surface it (do NOT retry; honest error). This is a real
          // miss that then errored; count it as a miss so the denominator stays honest.
          recordCacheResult('miss', metricId);
          throw err;
        }
        if (state.outcome === 'ok') {
          // Compute succeeded but the cache SET failed — return the value, drop the write. The
          // compute DID run (a miss), but the cache layer misbehaved → label 'error', not 'miss'.
          recordCacheResult('error', metricId);
          console.warn(
            `[metric-engine] serving cache write failed (value served, cache skipped): ${err instanceof Error ? err.message : String(err)}`,
          );
          return state.value as T;
        }
        // computeOutcome === 'pending' → the cache GET failed before compute ran → direct read.
        recordCacheResult('error', metricId);
        console.warn(
          `[metric-engine] serving cache unavailable — reading duckdb-serving directly: ${err instanceof Error ? err.message : String(err)}`,
        );
        return compute();
      }
    },
  };
}
