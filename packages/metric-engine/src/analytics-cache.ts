/**
 * @brain/metric-engine — AnalyticsCachePort + IoredisCacheAdapter.
 *
 * ── KEY FORMAT (brand_id-LEADING) ────────────────────────────────────────────
 * Every cache key has the form:
 *   `${brandId}:${metricId}:${paramsHash}:${servingVersion}`
 * The brand_id occupies the first segment so that per-brand cache invalidation
 * is a prefix scan (`SCAN 0 MATCH ${brandId}:*`) and any accidental cross-brand
 * leak is detectable from the key alone. Use buildCacheKey() to construct keys.
 *
 * ── STAMPEDE GUARD ────────────────────────────────────────────────────────────
 * IoredisCacheAdapter.getOrSet coalesces concurrent cache misses on the same key
 * via an in-process Promise map: only the FIRST caller computes the value and
 * writes it to Redis; subsequent concurrent callers await the same promise. This
 * eliminates the thundering-herd on hot metrics at the cost of per-instance scope
 * (sufficient for single-instance deployments; distributed guard can be layered on
 * with Redis SETNX if multi-instance stampede protection is needed later).
 *
 * ── DRIVER-AGNOSTIC PORT ─────────────────────────────────────────────────────
 * AnalyticsCachePort is a pure interface with no ioredis import. The concrete
 * adapter (IoredisCacheAdapter) accepts a RedisCacheClient (structural interface
 * compatible with ioredis.Redis). The composition root injects the SINGLE shared
 * ioredis instance — IoredisCacheAdapter does NOT create a second Redis client.
 *
 * ── SERVING VERSION ───────────────────────────────────────────────────────────
 * The servingVersion segment (e.g. 'v1') is the brain_serving materialization
 * version. A StarRocks MV rebuild bumps the version → automatic cache invalidation
 * without flushing all keys.
 */

// ── BigInt-safe JSON (the serving DTOs carry bigint money/counts) ───────────────
// JSON.stringify THROWS on bigint and JSON.parse can't restore it, so the cache must encode bigints as
// a tagged token on write and reconstruct them on read — keeping the round-trip type-preserving.
const BIGINT_TAG = '__brain_bigint__';

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value;
}

export function bigintReviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    BIGINT_TAG in (value as Record<string, unknown>) &&
    typeof (value as Record<string, unknown>)[BIGINT_TAG] === 'string'
  ) {
    return BigInt((value as Record<string, string>)[BIGINT_TAG]!);
  }
  return value;
}

// ── Key builder ───────────────────────────────────────────────────────────────

/**
 * Build a brand_id-LEADING composite cache key.
 *
 * @param brandId        - The brand UUID (must be the first segment — isolation invariant).
 * @param metricId       - The registered metric id (from MetricId).
 * @param paramsHash     - Stable hash of the query parameters (caller responsibility).
 * @param servingVersion - The serving-tier version string (e.g. 'v1').
 * @returns `${brandId}:${metricId}:${paramsHash}:${servingVersion}`
 */
export function buildCacheKey(
  brandId: string,
  metricId: string,
  paramsHash: string,
  servingVersion: string,
): string {
  // Enforce brand_id-leading by construction — callers cannot reorder args.
  return `${brandId}:${metricId}:${paramsHash}:${servingVersion}`;
}

// ── PORT ──────────────────────────────────────────────────────────────────────

/**
 * Driver-agnostic analytics cache port.
 * Implement this interface to swap the backing store (Redis, in-memory, etc.).
 */
export interface AnalyticsCachePort {
  /** Retrieve a cached value. Returns null on miss. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Store a value with a TTL in milliseconds. */
  set<T = unknown>(key: string, value: T, ttlMs: number): Promise<void>;
  /** Evict a key (e.g. on upstream data change). */
  invalidate(key: string): Promise<void>;
  /**
   * Stampede-guarded get-or-compute.
   * On a cache miss: coalesces concurrent calls on the same key so `compute` is
   * called only once, stores the result with `ttlMs`, and returns it to all waiters.
   * Preferred over bare get+set for hot paths.
   */
  getOrSet<T = unknown>(key: string, compute: () => Promise<T>, ttlMs: number): Promise<T>;
}

// ── Redis structural interface (no ioredis import) ────────────────────────────

/**
 * Minimal Redis client interface. Structurally compatible with ioredis.Redis so
 * the shared instance from apps/core/src/main.ts can be injected without importing
 * the ioredis package into this library.
 */
export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  /** Supports: set(key, value, 'PX', ttlMs) — ioredis overload. */
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<number>;
}

// ── Concrete adapter ───────────────────────────────────────────────────────────

/**
 * IoredisCacheAdapter — implements AnalyticsCachePort over a shared ioredis client.
 * Do NOT construct multiple adapters per process; the single shared Redis client
 * should be injected once at the composition root.
 */
export class IoredisCacheAdapter implements AnalyticsCachePort {
  /**
   * In-process stampede guard: maps cache key → the in-flight compute Promise.
   * Concurrent misses on the same key all await the same Promise.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly redis: RedisCacheClient) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw, bigintReviver) as T;
    } catch {
      // Malformed cache entry — treat as miss (will be overwritten on next set).
      return null;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlMs: number): Promise<void> {
    // BigInt-safe: Brain money/counts are bigint (amount_minor, lifetime_value_minor, …) and a plain
    // JSON.stringify THROWS on bigint ("Do not know how to serialize a BigInt"). bigintReplacer encodes
    // them as a tagged token; bigintReviver (in get) reconstructs the bigint on read — so the cache
    // round-trip is type-preserving, not lossy.
    await this.redis.set(key, JSON.stringify(value, bigintReplacer), 'PX', ttlMs);
  }

  async invalidate(key: string): Promise<void> {
    await this.redis.del(key);
    // Also remove from in-flight map so the next getOrSet re-computes immediately.
    this.inFlight.delete(key);
  }

  async getOrSet<T = unknown>(key: string, compute: () => Promise<T>, ttlMs: number): Promise<T> {
    // Fast path: serve from Redis. The cache is an OPTIMIZATION, never a correctness dependency — a
    // cache READ fault (Redis down, malformed entry) must degrade to a direct compute, not a 500.
    try {
      const cached = await this.get<T>(key);
      if (cached !== null) return cached;
    } catch {
      // cache read failed — fall through and compute directly.
    }

    // Stampede guard: if another call is already computing this key, join it.
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing !== undefined) return existing;

    // This call wins the race — compute, then BEST-EFFORT store. A cache WRITE fault (Redis error,
    // serialization edge) must return the freshly-computed value, NEVER fail the request. Before the
    // BigInt-safe serializer + this guard, a bigint result threw in set() and 500'd every cached
    // analytics endpoint (revenue, orders, customer marts) — the cache write took down the read.
    const promise: Promise<T> = compute()
      .then(async (value) => {
        this.inFlight.delete(key);
        try {
          await this.set(key, value, ttlMs);
        } catch {
          // best-effort cache write — value is still returned below.
        }
        return value;
      })
      .catch((err: unknown) => {
        // A genuine COMPUTE error (bad query) still propagates; just clean up the in-flight entry.
        this.inFlight.delete(key);
        throw err;
      });

    this.inFlight.set(key, promise as Promise<unknown>);
    return promise;
  }
}
