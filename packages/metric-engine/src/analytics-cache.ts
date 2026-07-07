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
 * ── STAMPEDE GUARD (two layers) ───────────────────────────────────────────────
 * IoredisCacheAdapter.getOrSet coalesces concurrent cache misses on the same key:
 *   1. IN-PROCESS: a Promise map — only the FIRST caller in this process computes;
 *      concurrent callers await the same promise.
 *   2. DISTRIBUTED (multi-instance): a best-effort Redis SET-NX lock on
 *      `${key}:lock` — across instances only the lock WINNER recomputes a missed
 *      key; losers briefly poll the value key and serve the winner's write, falling
 *      back to a direct compute if it doesn't land in time. The lock is an
 *      OPTIMIZATION, never a correctness dependency: any lock-op failure degrades
 *      to the pre-lock behavior (compute directly), and a lost/expired lock at
 *      worst costs one duplicate compute. Reads are never blocked on the lock.
 *      The lock key stays brand_id-LEADING (it extends the value key), so the
 *      isolation-by-prefix property and the invalidation SCAN both still hold.
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

import { createHash } from 'node:crypto';

// ── BigInt-safe JSON (the serving DTOs carry bigint money/counts) ───────────────
// JSON.stringify THROWS on bigint and JSON.parse can't restore it, so the cache must encode bigints as
// a tagged token on write and reconstruct them on read — keeping the round-trip type-preserving.
const BIGINT_TAG = '__brain_bigint__';

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value;
}

function bigintReviver(_key: string, value: unknown): unknown {
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

// ── SPEC: D.3 / §1.11.2 — BAI-query-shaped result cache key ─────────────────────
// The natural-language / structured BAI ask path does not have a single (metricId, params)
// tuple like a dashboard read — it has a QUERY. §1.11.2 specifies a query-result cache keyed
// `{brand_id}:q:{normalized_query_hash}` so two syntactically-different-but-semantically-identical
// asks ("revenue last 7 days" vs "  Revenue Last 7 Days ") share one cached answer. The key stays
// brand_id-LEADING so the SAME `${brandId}:*` SCAN invalidation (and the crypto-shred cache bust)
// covers it, and any cross-brand leak is detectable from the key alone. The `q` namespace segment
// keeps it disjoint from the metric-serving keyspace (which uses the metricId as segment 2).

/**
 * Canonicalize a BAI query string for cache-key hashing: trim, lowercase, and collapse all
 * internal whitespace runs to a single space. Two asks that differ only in case / spacing hash
 * identically → one cached answer. Intentionally conservative (no stemming / token reordering):
 * a stronger normalizer can be layered later without changing the key SHAPE.
 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Stable, collision-resistant hash of a normalized BAI query for the cache key. */
export function hashQuery(query: string): string {
  return createHash('sha256').update(normalizeQuery(query)).digest('hex').slice(0, 16);
}

/**
 * Build the brand_id-LEADING BAI query-result cache key: `${brandId}:q:${normalized_query_hash}`.
 * brand_id leads (isolation invariant + `${brandId}:*` SCAN invalidation); the `q` segment keeps
 * BAI answers disjoint from the metric-serving keyspace built by buildCacheKey().
 */
export function buildQueryCacheKey(brandId: string, query: string): string {
  return `${brandId}:q:${hashQuery(query)}`;
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

// ── Distributed-lock options (stampede guard layer 2) ─────────────────────────

/**
 * Tuning for the cross-instance SET-NX rebuild lock. All timings are milliseconds.
 * Defaults suit interactive serving reads (a Trino metric read is typically < 5s).
 */
export interface DistributedLockOptions {
  /** Master switch — false restores the pure in-process behavior. Default true. */
  readonly enabled: boolean;
  /** Lock lifetime (PX on the SET-NX). Must exceed the slowest expected compute. Default 15s. */
  readonly lockTtlMs: number;
  /** How often a lock LOSER polls the value key for the winner's write. Default 100ms. */
  readonly pollIntervalMs: number;
  /** How long a loser polls before giving up and computing directly. Default 3s. */
  readonly maxPollMs: number;
}

const DEFAULT_LOCK_OPTIONS: DistributedLockOptions = {
  enabled: true,
  lockTtlMs: 15_000,
  pollIntervalMs: 100,
  maxPollMs: 3_000,
};

/** Suffix appended to the VALUE key to form the lock key — keeps brand_id leading. */
const LOCK_SUFFIX = ':lock';

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

  private readonly lockOptions: DistributedLockOptions;
  /** Injectable for tests (fake timers without real waiting). */
  private readonly sleep: (ms: number) => Promise<void>;
  private lockSeq = 0;

  constructor(
    private readonly redis: RedisCacheClient,
    lockOptions?: Partial<DistributedLockOptions>,
    sleep?: (ms: number) => Promise<void>,
  ) {
    this.lockOptions = { ...DEFAULT_LOCK_OPTIONS, ...lockOptions };
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

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

    // In-process stampede guard: if another call in THIS process is already computing, join it.
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing !== undefined) return existing;

    const promise: Promise<T> = this.computeWithDistributedLock(key, compute, ttlMs)
      .then((value) => {
        this.inFlight.delete(key);
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

  /**
   * DISTRIBUTED stampede guard (layer 2): a best-effort SET-NX lock on `${key}:lock` so that
   * across INSTANCES only one rebuilds a missed key.
   *   - lock ACQUIRED → compute + store, then release the lock (check-token-then-DEL, best-effort).
   *   - lock LOST     → another instance is computing: poll the value key briefly and serve its
   *                     write; if it doesn't land within maxPollMs, compute directly (a read is
   *                     NEVER blocked indefinitely on the lock).
   *   - lock ERROR    → degrade to the pre-lock behavior (compute directly).
   */
  private async computeWithDistributedLock<T>(
    key: string,
    compute: () => Promise<T>,
    ttlMs: number,
  ): Promise<T> {
    if (!this.lockOptions.enabled) return this.computeAndStore(key, compute, ttlMs);

    const lockKey = `${key}${LOCK_SUFFIX}`;
    // Owner token: releasing checks it so an expired lock's successor isn't unlocked by us.
    const token = `${Date.now().toString(36)}-${(this.lockSeq++).toString(36)}-${Math.random().toString(36).slice(2)}`;

    let acquired: boolean;
    try {
      acquired =
        (await this.redis.set(lockKey, token, 'PX', this.lockOptions.lockTtlMs, 'NX')) === 'OK';
    } catch {
      // Lock layer unavailable — never block/fail a read because of the guard.
      return this.computeAndStore(key, compute, ttlMs);
    }

    if (acquired) {
      try {
        return await this.computeAndStore(key, compute, ttlMs);
      } finally {
        await this.releaseLock(lockKey, token);
      }
    }

    // Lock lost to another INSTANCE — wait briefly for its value write, then fall back.
    const settled = await this.pollForValue<T>(key);
    if (settled !== null) return settled;
    return this.computeAndStore(key, compute, ttlMs);
  }

  /**
   * Compute, then BEST-EFFORT store. A cache WRITE fault (Redis error, serialization edge) must
   * return the freshly-computed value, NEVER fail the request. Before the BigInt-safe serializer
   * + this guard, a bigint result threw in set() and 500'd every cached analytics endpoint
   * (revenue, orders, customer marts) — the cache write took down the read.
   */
  private async computeAndStore<T>(key: string, compute: () => Promise<T>, ttlMs: number): Promise<T> {
    const value = await compute();
    try {
      await this.set(key, value, ttlMs);
    } catch {
      // best-effort cache write — value is still returned.
    }
    return value;
  }

  /**
   * Best-effort lock release: DEL only when the lock still holds OUR token. The check-then-delete
   * pair is not atomic (RedisCacheClient has no EVAL) — acceptable because the lock is an
   * optimization: the worst race (deleting a successor's lock) costs one duplicate compute.
   */
  private async releaseLock(lockKey: string, token: string): Promise<void> {
    try {
      if ((await this.redis.get(lockKey)) === token) {
        await this.redis.del(lockKey);
      }
    } catch {
      // Leave the lock to its PX expiry.
    }
  }

  /** Poll the value key for the lock winner's write. Null → give up (caller computes directly). */
  private async pollForValue<T>(key: string): Promise<T | null> {
    const { pollIntervalMs, maxPollMs } = this.lockOptions;
    const attempts = Math.max(1, Math.floor(maxPollMs / Math.max(1, pollIntervalMs)));
    for (let i = 0; i < attempts; i++) {
      await this.sleep(pollIntervalMs);
      try {
        const value = await this.get<T>(key);
        if (value !== null) return value;
      } catch {
        // Cache read failing while we wait → stop polling, compute directly.
        return null;
      }
    }
    return null;
  }
}
