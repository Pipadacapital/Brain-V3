// SPEC: D.3 / §1.11.3
/**
 * @brain/metric-engine — per-brand serving admission gate (concurrency + FIFO queue + timeout).
 *
 * (Renamed from trino-brand-gate.ts — engine-neutral rename, ADR-0014 Trino removal.)
 *
 * §1.11.3 requires a PER-BRAND serving concurrency gate at the single serving chokepoint: one runaway
 * brand (a dashboard fan-out, a BAI storm) must not exhaust the shared duckdb-serving replicas'
 * admission slots and starve every other tenant. The metric-engine has exactly ONE place every
 * serving query flows through: the ServingPool. This module wraps ANY ServingPool with a brand-keyed
 * admission gate:
 *
 *   • per-brand max-concurrent  — at most N in-flight queries per brand_id.
 *   • per-brand FIFO queue      — over-limit queries wait in arrival order (fairness within a brand).
 *   • bounded queue             — a full queue REJECTS (fail-loud overload, never unbounded memory).
 *   • acquire timeout           — a query that can't get a slot in time REJECTS (never pins a request).
 *
 * The gate is ADDITIVE and DEFAULT-PERMISSIVE: with the shipped defaults it wraps the pool without
 * changing behavior for normal load; it only bites under genuine per-brand overload. It sits BELOW
 * the withServingBrand/withSilverBrand seam (it wraps the concrete pool), so the brand_id is read from
 * the LAST query param — the documented seam invariant: "the brand-isolation seam appends brandId as
 * the LAST param" (serving-deps.ts / duckdb-serving-adapter.ts). A query with no string tail param
 * (rare operator ad-hoc) falls into a shared '__unkeyed__' bucket rather than bypassing the gate.
 *
 * NOTE ON ISOLATION: the gate is a LIVENESS/fairness control, NOT the tenant-isolation mechanism —
 * that remains the ${BRAND_PREDICATE} injection at the seam (proven by the isolation-fuzz test). The
 * gate never inspects or rewrites SQL; it only schedules calls to the wrapped pool.
 *
 * @see packages/metric-engine/src/serving-deps.ts           — the brand-scoped seam (appends brandId last)
 * @see packages/metric-engine/src/duckdb-serving-adapter.ts — the concrete pool this wraps
 */

import type { ServingPool } from './serving-deps.js';

// ── Config ──────────────────────────────────────────────────────────────────────

export interface PerBrandServingGateConfig {
  /**
   * Max simultaneously-running queries per brand_id. Default 8 — comfortably above a single
   * dashboard's parallel panel loads, low enough that one brand can't monopolize the serving
   * replicas. Set from config/env at the composition root.
   */
  readonly maxConcurrentPerBrand?: number;
  /**
   * Max queued (waiting) queries per brand_id once max-concurrent is saturated. Default 64.
   * A brand that exceeds concurrent + queue is genuinely overloaded → the extra query REJECTS
   * (honest 503-shaped error) rather than growing memory unbounded.
   */
  readonly maxQueuePerBrand?: number;
  /**
   * Max ms a query waits in the FIFO queue for a slot before REJECTING. Default 15_000 — aligned
   * with the p95<10s ad-hoc budget plus headroom; a query that can't start in this window is shed
   * rather than pinning the BFF request behind a saturated brand.
   */
  readonly acquireTimeoutMs?: number;
  /**
   * Extract the brand key from a query's params. Default: the LAST param if it is a string (the seam
   * appends brandId last). Override only for tests / non-standard call shapes.
   */
  readonly brandKeyOf?: (params: unknown[]) => string | undefined;
}

const DEFAULTS = {
  maxConcurrentPerBrand: 8,
  maxQueuePerBrand: 64,
  acquireTimeoutMs: 15_000,
} as const;

/** Default brand-key extractor: the last param if it's a string, else the shared unkeyed bucket. */
export function defaultBrandKeyOf(params: unknown[]): string | undefined {
  const last = params[params.length - 1];
  return typeof last === 'string' && last.length > 0 ? last : undefined;
}

const UNKEYED = '__unkeyed__';

// ── Error ───────────────────────────────────────────────────────────────────────

/** Thrown when a query is shed by the gate (queue full or acquire timeout). Fail-loud, honest. */
export class ServingGateRejectedError extends Error {
  readonly brandKey: string;
  readonly reason: 'queue_full' | 'acquire_timeout';
  constructor(brandKey: string, reason: 'queue_full' | 'acquire_timeout', detail: string) {
    super(`[serving-gate] query rejected for brand ${brandKey} (${reason}): ${detail}`);
    this.name = 'ServingGateRejectedError';
    this.brandKey = brandKey;
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Per-brand bucket ──────────────────────────────────────────────────────────

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Bucket {
  active: number;
  queue: Waiter[];
}

// ── Factory ─────────────────────────────────────────────────────────────────────

/**
 * Wrap a ServingPool with a per-brand admission gate. Returns a ServingPool with the SAME interface,
 * so the composition root swaps it in transparently
 * (createPerBrandServingGate(createDuckDbServingPool(...))).
 *
 * @param pool   - the concrete pool to protect (e.g. from createDuckDbServingPool).
 * @param config - gate limits (all optional; defaults are permissive).
 */
export function createPerBrandServingGate(
  pool: ServingPool,
  config: PerBrandServingGateConfig = {},
): ServingPool {
  const maxConcurrent = config.maxConcurrentPerBrand ?? DEFAULTS.maxConcurrentPerBrand;
  const maxQueue = config.maxQueuePerBrand ?? DEFAULTS.maxQueuePerBrand;
  const acquireTimeoutMs = config.acquireTimeoutMs ?? DEFAULTS.acquireTimeoutMs;
  const brandKeyOf = config.brandKeyOf ?? defaultBrandKeyOf;

  const buckets = new Map<string, Bucket>();

  function bucketFor(key: string): Bucket {
    let b = buckets.get(key);
    if (!b) {
      b = { active: 0, queue: [] };
      buckets.set(key, b);
    }
    return b;
  }

  /** Acquire a slot for `key`. Resolves when a slot is granted; rejects on queue-full / timeout. */
  function acquire(key: string): Promise<void> {
    const b = bucketFor(key);
    if (b.active < maxConcurrent) {
      b.active++;
      return Promise.resolve();
    }
    if (b.queue.length >= maxQueue) {
      return Promise.reject(
        new ServingGateRejectedError(
          key,
          'queue_full',
          `active=${b.active} queued=${b.queue.length} limit=${maxConcurrent}+${maxQueue}`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        // Remove from queue (still waiting) and reject — never leave a dangling promise.
        const idx = b.queue.indexOf(waiter);
        if (idx >= 0) b.queue.splice(idx, 1);
        reject(
          new ServingGateRejectedError(key, 'acquire_timeout', `waited ${acquireTimeoutMs}ms for a slot`),
        );
      }, acquireTimeoutMs);
      b.queue.push(waiter);
    });
  }

  /** Release a slot for `key` and promote the next FIFO waiter (if any). */
  function release(key: string): void {
    const b = buckets.get(key);
    if (!b) return;
    const next = b.queue.shift();
    if (next) {
      // Hand the just-freed slot straight to the next waiter (active stays constant).
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
    } else {
      b.active = Math.max(0, b.active - 1);
      // Drop empty idle buckets so a long-lived process doesn't accumulate one map entry per brand.
      if (b.active === 0 && b.queue.length === 0) buckets.delete(key);
    }
  }

  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const key = brandKeyOf(params) ?? UNKEYED;
      await acquire(key);
      try {
        return await pool.query<T>(sql, params);
      } finally {
        release(key);
      }
    },
  };
}
