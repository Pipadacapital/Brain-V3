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
 *   result=stale → SWR path only: a value past its SOFT ttl was served IMMEDIATELY (no blocking
 *                  compute) while a background revalidation refreshes it. Counts as a fast serve —
 *                  the win SWR buys — but kept a distinct label so it doesn't inflate the fresh-hit
 *                  ratio (a stale serve did NOT reflect the latest transform tick).
 * metric_id is bounded (~49 registered metrics) → safe label cardinality.
 * Hit rate = rate(...{result="hit"}) / rate(...{result=~"hit|miss"}); fast-serve rate folds in "stale".
 */
function recordCacheResult(
  result: 'hit' | 'miss' | 'bypass' | 'error' | 'stale',
  metricId: string,
): void {
  incrementCounter('serving_cache_requests_total', { result, metric_id: metricId });
}

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * ADR-0019 WS-2 — stale-while-revalidate options. Flag-gated, DEFAULT-OFF: with `enabled: false`
 * (or no swr block) the reader behaves EXACTLY as before (getOrSet fresh-or-block). When ON, a read
 * that finds a value past its SOFT ttl serves it IMMEDIATELY and refreshes it in the background — so
 * the first hit after a TTL boundary no longer pays the full cold serving round-trip.
 */
export interface ServingSwrOptions {
  /** `SERVING_CACHE_SWR`. false → no SWR (identical to today's getOrSet path). */
  readonly enabled: boolean;
  /**
   * Extra window (ms) a value may be served STALE past its soft ttl while a background revalidation
   * recomputes it. The hard Redis TTL of an SWR entry = softTtl + staleGraceMs; past the hard TTL the
   * entry is evicted and the next read is a blocking miss. Default 600_000 (10m).
   */
  readonly staleGraceMs: number;
}

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
  /** ADR-0019 WS-2 stale-while-revalidate. Omitted/disabled → unchanged getOrSet behavior. */
  readonly swr?: ServingSwrOptions;
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
  /**
   * True iff the cache is enabled AND SWR is on (ADR-0019 WS-2). Routes use this to decide whether a
   * historically-uncached headline metric (blended_roas, order_status_mix) should be routed through
   * the cache — so those reads stay byte-for-byte today's behavior until SERVING_CACHE_SWR flips on.
   */
  readonly swrEnabled: boolean;
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

// ── SWR envelope (ADR-0019 WS-2) ──────────────────────────────────────────────

/** Default stale-serve grace window past the soft ttl (ms). */
const DEFAULT_STALE_GRACE_MS = 600_000;

/**
 * SWR entries are stored under a `:swr`-suffixed key so the stale envelope and the plain getOrSet
 * value NEVER share a key — toggling SERVING_CACHE_SWR on/off can never misread one format as the
 * other. The suffix EXTENDS the brand-leading key, so `${brandId}:*` invalidation still covers it.
 */
const SWR_SUFFIX = ':swr';

/** The wire form of an SWR-cached value: the value plus the instant it becomes stale. */
interface SwrEnvelope<T> {
  readonly __swr: 1;
  readonly v: T;
  /** epoch ms; now >= softExpiresAt → serve stale + revalidate. */
  readonly softExpiresAt: number;
}

function isSwrEnvelope(x: unknown): x is SwrEnvelope<unknown> {
  return (
    x !== null &&
    typeof x === 'object' &&
    (x as { __swr?: unknown }).__swr === 1 &&
    typeof (x as { softExpiresAt?: unknown }).softExpiresAt === 'number' &&
    'v' in (x as Record<string, unknown>)
  );
}

function makeEnvelope<T>(value: T, softTtlMs: number): SwrEnvelope<T> {
  return { __swr: 1, v: value, softExpiresAt: Date.now() + softTtlMs };
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a ServingCacheReader. Inject at the composition root; pass to the BFF metric
 * routes. When `enabled` is false the returned reader is a pure pass-through.
 */
export function createServingCacheReader(config: ServingCacheReaderConfig): ServingCacheReader {
  const { cache, servingVersion, ttlMs, enabled } = config;
  const swrOn = enabled && (config.swr?.enabled ?? false);
  const staleGraceMs = config.swr?.staleGraceMs ?? DEFAULT_STALE_GRACE_MS;

  /**
   * In-process single-flight for background revalidation: at most one refresh per key runs at a time
   * in THIS process. Cross-instance duplicate refreshes are tolerated (bounded to one per instance,
   * same as the getOrSet lock-loser fallback) — a revalidation is best-effort, never correctness.
   */
  const revalidating = new Set<string>();

  /** Best-effort envelope write (a cache SET fault must never surface to a caller). */
  async function storeEnvelope<T>(key: string, value: T, softTtlMs: number): Promise<void> {
    try {
      await cache.set(key, makeEnvelope(value, softTtlMs), softTtlMs + staleGraceMs);
    } catch {
      // best-effort: the value was already served (or will be), drop the write.
    }
  }

  /** Fire-and-forget background refresh of a stale key; single-flight; never throws to the caller. */
  function scheduleRevalidate<T>(
    key: string,
    metricId: string,
    compute: () => Promise<T>,
    softTtlMs: number,
  ): void {
    if (revalidating.has(key)) return; // a refresh for this key is already in flight in-process.
    revalidating.add(key);
    void (async () => {
      try {
        const value = await compute();
        await storeEnvelope(key, value, softTtlMs);
      } catch (err) {
        // Refresh failed — keep serving the stale value until the hard TTL evicts it. Log once.
        console.warn(
          `[metric-engine] SWR background revalidate failed for ${metricId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        revalidating.delete(key);
      }
    })();
  }

  /** ADR-0019 WS-2 stale-while-revalidate read path (only reached when swrOn). */
  async function readSwr<T>(
    brandId: string,
    metricId: string,
    params: unknown,
    compute: () => Promise<T>,
  ): Promise<T> {
    const key = `${buildCacheKey(brandId, metricId, hashParams(params), servingVersion)}${SWR_SUFFIX}`;
    const softTtlMs = resolveServingTtlMs(metricId, ttlMs);

    // 1. Read the envelope (fail-soft: a cache-read fault falls through to a blocking miss).
    let env: SwrEnvelope<T> | null = null;
    try {
      const raw = await cache.get<unknown>(key);
      if (isSwrEnvelope(raw)) env = raw as SwrEnvelope<T>;
    } catch {
      env = null;
    }

    if (env) {
      if (Date.now() < env.softExpiresAt) {
        recordCacheResult('hit', metricId); // fresh
        return env.v;
      }
      // Stale but present → serve it NOW, refresh in the background (single-flight).
      recordCacheResult('stale', metricId);
      scheduleRevalidate(key, metricId, compute, softTtlMs);
      return env.v;
    }

    // 2. True miss → compute under the stampede guard and store the envelope. A compute error
    //    propagates honestly (getOrSet never swallows it, never double-reads).
    recordCacheResult('miss', metricId);
    const filled = await cache.getOrSet<SwrEnvelope<T>>(
      key,
      async () => makeEnvelope(await compute(), softTtlMs),
      softTtlMs + staleGraceMs,
    );
    return filled.v;
  }

  return {
    swrEnabled: swrOn,
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

      // ADR-0019 WS-2 — stale-while-revalidate (flag-gated). OFF → the unchanged getOrSet path below.
      if (swrOn) return readSwr(brandId, metricId, params, compute);

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
