/**
 * IdentifierCacheAdapter — the `identifier_hash → brain_id` Redis cache fronting the Neo4j identity
 * SoR in the Silver identity stage (ADR-0015 WS3 / doc-18 PR 3.1).
 *
 * WHY: the batch identity job re-sees the SAME identifiers on almost every event (a returning
 * customer's email/anon on each page view). Only FIRST-SEEN identifiers need the graph; a fully
 * cached, single-brain event is a guaranteed no-op resolve (link of already-linked hashes) and is
 * skipped without a Neo4j round-trip. Sibling of RedisDedupAdapter (same ioredis idiom).
 *
 * KEYS: `{brand_id}:idhash:{identifier_type}:{identifier_hash}` — tenant-prefixed (I-S01),
 *   value = the resolved brain_id UUID (opaque, never PII; the hash itself is 64-hex, I-S02).
 * TTL: SILVER_IDENTITY_CACHE_TTL_SECONDS (default 7d) — sliding on every prime.
 *
 * STALENESS IS SAFE BY CONSTRUCTION: a cached brain_id that was later merged away still
 * alias-resolves to the canonical in the graph AND in silver_identity_map (the ALIAS_OF chain), so
 * skipping the graph write for an already-known identifier can never lose a link — it only skips a
 * write that would have been an idempotent no-op. The serving-cache eviction path may also drop
 * these keys (`${brand}:*` scans); that is a pure cache miss → next event re-primes from the graph.
 */
import { Redis } from 'ioredis';

export interface IIdentifierCache {
  /** Bulk lookup — returns brain_id (or null) per (type, hash), input order preserved. */
  getMany(
    brandId: string,
    ids: Array<{ type: string; hash: string }>,
  ): Promise<Array<string | null>>;
  /** Bulk prime — best-effort (a Redis blip never fails the resolve that already committed). */
  primeMany(
    brandId: string,
    entries: Array<{ type: string; hash: string; brainId: string }>,
  ): Promise<void>;
}

function cacheKey(brandId: string, type: string, hash: string): string {
  return `${brandId}:idhash:${type}:${hash}`;
}

export class IdentifierCacheAdapter implements IIdentifierCache {
  private readonly redis: InstanceType<typeof Redis>;

  constructor(
    redisUrl: string,
    /** TTL seconds for every primed entry (sliding — re-primed on each sighting). */
    private readonly ttlSeconds: number,
  ) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
    });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async getMany(
    brandId: string,
    ids: Array<{ type: string; hash: string }>,
  ): Promise<Array<string | null>> {
    if (ids.length === 0) return [];
    try {
      const values = await this.redis.mget(...ids.map((i) => cacheKey(brandId, i.type, i.hash)));
      return values.map((v) => (typeof v === 'string' && v.length > 0 ? v : null));
    } catch {
      // Cache is ONLY an optimization: a Redis hiccup = miss for the whole batch → the graph
      // (the SoR) answers. Never throw — the identity stage must not fail on a cache blip.
      return ids.map(() => null);
    }
  }

  async primeMany(
    brandId: string,
    entries: Array<{ type: string; hash: string; brainId: string }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const e of entries) {
        pipeline.set(cacheKey(brandId, e.type, e.hash), e.brainId, 'EX', this.ttlSeconds);
      }
      await pipeline.exec();
    } catch {
      // Best-effort by contract: the graph write already committed. Swallow and move on.
    }
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}
