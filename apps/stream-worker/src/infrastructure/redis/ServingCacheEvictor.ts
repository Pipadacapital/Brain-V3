/**
 * ServingCacheEvictor — DIRECT brand-scoped eviction of the Redis analytics serving cache.
 *
 * ADR-0015 WS3: the cache.invalidate.v1 / gold.rewritten.v1 Kafka lane is RETIRED. The eviction
 * logic here is INLINED VERBATIM from the removed AnalyticsCacheInvalidateConsumer (same tenant
 * guards, same durable-config exemption, same SCAN+DEL loop) and is now invoked in-process by:
 *   - the Silver identity stage (jobs/silver-identity) after a merge/suppress outcome,
 *   - the gold-rewritten-publish job (post-Gold refresh brand-wide bust),
 *   - the erasure orchestrator (EraseSubjectUseCase's cache-invalidation port, via the
 *     DirectServingCacheInvalidator adapter below).
 *
 * ── TENANT ISOLATION INVARIANTS (unchanged from the consumer) ─────────────────
 * 1. SCAN patterns are ALWAYS prefixed with `${brandId}:` — a SCAN that lacks the brand_id
 *    prefix MUST NOT run (would scan all tenants' keys = P0 isolation breach).
 * 2. Exact-key deletes are gated: a key is ONLY deleted if key.startsWith(`${brandId}:`).
 * 3. An empty/missing brandId → no eviction.
 *
 * ── DURABLE-CONFIG EXEMPTION (SPEC: 0.5 / AMD-23) ────────────────────────────
 * Durable per-brand CONFIG sharing the brand-first keyspace is NEVER deleted here:
 * `{brand_id}:flag:{name}` (@brain/platform-flags) is skipped by every delete path. Any future
 * durable per-brand config namespace must be added to DURABLE_CONFIG_NAMESPACES.
 *
 * ── FAIL-OPEN ────────────────────────────────────────────────────────────────
 * Eviction is an optimization: on a Redis error we log + return the partial count — the
 * serving-cache TTL remains the correctness safety net. Callers never retry an eviction.
 */
import type { ScopedRecompute } from '../../domain/identity/ScopedRecompute.js';
import type { IErasureCacheInvalidatePublisher } from '../../application/EraseSubjectUseCase.js';
import { log } from '../../log.js';

/**
 * Minimal Redis eviction port. Structurally compatible with ioredis.Redis.
 * (Moved from the removed AnalyticsCacheInvalidateConsumer — same shape, so tests can
 * inject a fake without standing up Redis.)
 */
export interface ICacheEvictionClient {
  /** Delete an exact Redis key. Returns the number of keys deleted (idempotent on absent keys). */
  del(key: string): Promise<number>;
  /** Cursor-based SCAN: scan(cursor, 'MATCH', pattern, 'COUNT', batchSize) → [nextCursor, keys]. */
  scan(cursor: string, matchArg: string, pattern: string, countArg: string, batchSize: number): Promise<[string, string[]]>;
}

/**
 * Second key segments that are durable per-brand CONFIG (not cache) and therefore exempt from
 * every eviction path. Keep in lockstep with the sanctioned key builders in @brain/tenant-context
 * (flagKey → `{brand_id}:flag:{name}`).
 */
const DURABLE_CONFIG_NAMESPACES = ['flag'] as const;

/** Is this brand-owned key durable config (never evicted by cache invalidation)? Module-local. */
function isDurableConfigKey(key: string, brandId: string): boolean {
  return DURABLE_CONFIG_NAMESPACES.some((ns) => key.startsWith(`${brandId}:${ns}:`));
}

export class ServingCacheEvictor {
  constructor(private readonly cacheClient: ICacheEvictionClient) {}

  /**
   * Evict EVERY brand-scoped serving-cache key (`${brandId}:*`, durable config exempted).
   * Fail-open: a Redis error logs + returns the partial count. Returns keys deleted.
   */
  async evictBrand(brandId: string): Promise<number> {
    if (!brandId || brandId.trim().length === 0) {
      log.warn('[serving-cache-evictor] empty brandId — refusing to evict (tenant guard)');
      return 0;
    }
    try {
      return await this.scanAndDelete(`${brandId}:*`, brandId);
    } catch (err) {
      log.warn('[serving-cache-evictor] Redis eviction error (fail-open — TTL is the safety net)', {
        brand_id: brandId, err,
      });
      return 0;
    }
  }

  /**
   * Cursor-based SCAN + DEL for a given pattern.
   * INVARIANT: pattern MUST start with `${brandId}:` — enforced here (defence in depth).
   */
  private async scanAndDelete(pattern: string, brandId: string): Promise<number> {
    if (!pattern.startsWith(`${brandId}:`)) {
      log.error(
        '[serving-cache-evictor] INVARIANT VIOLATED: SCAN pattern does not start with brand_id — aborting scan (cross-brand safety)',
        { pattern, brand_id: brandId },
      );
      return 0;
    }

    let cursor = '0';
    let deleted = 0;
    const BATCH_SIZE = 100;

    do {
      const [nextCursor, keys] = await this.cacheClient.scan(cursor, 'MATCH', pattern, 'COUNT', BATCH_SIZE);
      cursor = nextCursor;

      for (const key of keys) {
        // Final cross-brand guard: even inside a SCAN result, skip keys that don't match.
        if (!key.startsWith(`${brandId}:`)) {
          log.error('[serving-cache-evictor] SCAN returned a key not starting with brand_id — skipped', {
            key, brand_id: brandId, pattern,
          });
          continue;
        }
        // AMD-23: durable per-brand config (`{brand_id}:flag:*`) is not cache — skip silently.
        if (isDurableConfigKey(key, brandId)) continue;
        deleted += await this.cacheClient.del(key);
      }
    } while (cursor !== '0');

    return deleted;
  }
}

/**
 * DirectServingCacheInvalidator — fulfils the EraseSubjectUseCase cache-invalidation port
 * (IErasureCacheInvalidatePublisher) by evicting the brand's serving-cache keys DIRECTLY
 * instead of publishing cache.invalidate.v1 for a (removed) consumer. Same brand-wide scope the
 * former publisher requested (scope.all=true per affected mart ⇒ one brand-wide SCAN covers all).
 * Fail-open inside the use case (it wraps this call in its own try/catch).
 */
export class DirectServingCacheInvalidator implements IErasureCacheInvalidatePublisher {
  constructor(private readonly evictor: ServingCacheEvictor) {}

  async publishForRecompute(recompute: ScopedRecompute, causationEventId: string): Promise<void> {
    const deleted = await this.evictor.evictBrand(recompute.brand_id);
    log.info('[serving-cache-evictor] direct eviction for scoped recompute', {
      brand_id: recompute.brand_id,
      request_id: recompute.request_id,
      causation_event_id: causationEventId,
      keys_deleted: deleted,
    });
  }
}
