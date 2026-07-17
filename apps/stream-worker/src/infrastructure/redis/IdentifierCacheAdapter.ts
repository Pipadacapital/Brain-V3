/**
 * IdentifierCacheAdapter — the `identifier_hash → brain_id` Redis cache fronting the Neo4j identity
 * SoR in the Silver identity stage (ADR-0015 WS3 / doc-18 PR 3.1).
 *
 * WHY: the batch identity job re-sees the SAME identifiers on almost every event (a returning
 * customer's email/anon on each page view). Only FIRST-SEEN identifiers need the graph; a fully
 * cached, single-brain event is a guaranteed no-op resolve (link of already-linked hashes) and is
 * skipped without a Neo4j round-trip. Sibling of RedisDedupAdapter (same ioredis idiom).
 *
 * KEYS: `idcache:{brand_id}:idhash:{identifier_type}:{identifier_hash}` — PREFIX-FIRST so the
 *   ServingCacheEvictor's brand-wide `${brandId}:*` SCAN can NEVER match this keyspace (H2: the
 *   post-Gold cache-bust runs every refresh cycle for every active brand; brand-first keys made
 *   the identifier cache permanently cold and defeated the ADR-0015 Neo4j-bounding mitigation).
 *   Tenant isolation is preserved — brand_id is still IN every key, and every read/write/purge on
 *   this adapter is brand-scoped (I-S01). Value = the resolved brain_id UUID (opaque, never PII;
 *   the hash itself is 64-hex, I-S02).
 * TTL: SILVER_IDENTITY_CACHE_TTL_SECONDS (default 7d) — sliding on every prime.
 *
 * STALENESS IS SAFE BY CONSTRUCTION: a cached brain_id that was later merged away still
 * alias-resolves to the canonical in the graph AND in silver_identity_map (the ALIAS_OF chain), so
 * skipping the graph write for an already-known identifier can never lose a link — it only skips a
 * write that would have been an idempotent no-op. TTL expiry bounds any residual staleness.
 *
 * RTBF INTERPLAY: brand-wide serving-cache eviction NO LONGER clears this keyspace, so the
 * erasure lane must (and does) purge a shredded subject's entries EXPLICITLY via
 * purgeSubjectHashes() (EraseSubjectUseCase STEP 3c) — otherwise the erased brain_id would stay
 * mapped and the subject's post-erasure events would be cache-skipped instead of re-minted.
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

/**
 * RTBF purge port (EraseSubjectUseCase STEP 3c). Separate from IIdentifierCache because its error
 * contract is the OPPOSITE: purge failures THROW (fail-closed — the erasure lane must retry until
 * the shredded subject's hash→brain_id entries are gone), while lookup/prime swallow (best-effort).
 */
export interface IIdentifierCachePurge {
  /**
   * Delete every idcache entry for the given subject identifier hashes (all identifier types),
   * brand-scoped. Returns keys deleted. THROWS on Redis failure.
   */
  purgeSubjectHashes(brandId: string, identifierHashes: string[]): Promise<number>;
}

/**
 * The identifier-cache key. PREFIX-FIRST (`idcache:` before the brand) — deliberately OUTSIDE the
 * brand-first `${brandId}:*` serving-cache keyspace the ServingCacheEvictor sweeps (see module doc).
 * Exported for tests that prove the keyspace separation.
 */
export function identifierCacheKey(brandId: string, type: string, hash: string): string {
  return `idcache:${brandId}:idhash:${type}:${hash}`;
}

export class IdentifierCacheAdapter implements IIdentifierCache, IIdentifierCachePurge {
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
      const values = await this.redis.mget(...ids.map((i) => identifierCacheKey(brandId, i.type, i.hash)));
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
        pipeline.set(identifierCacheKey(brandId, e.type, e.hash), e.brainId, 'EX', this.ttlSeconds);
      }
      await pipeline.exec();
    } catch {
      // Best-effort by contract: the graph write already committed. Swallow and move on.
    }
  }

  /**
   * RTBF (EraseSubjectUseCase STEP 3c): delete the subject's idcache entries — every identifier
   * TYPE for each hash (the erasure lane enumerates hashes, not (type, hash) pairs, so each hash
   * is matched across types via a brand-scoped SCAN; hashes are 64-hex → glob-safe). Erasures are
   * rare, so the SCAN cost is acceptable. THROWS on Redis failure (fail-closed by contract — the
   * erasure orchestrator retries the idempotent sequence; a shredded subject's hash must NOT stay
   * mapped to the erased brain_id, else post-erasure events are cache-skipped and never re-minted).
   */
  async purgeSubjectHashes(brandId: string, identifierHashes: string[]): Promise<number> {
    if (!brandId || brandId.trim().length === 0) return 0; // tenant guard: never an unscoped scan
    let deleted = 0;
    for (const hash of identifierHashes) {
      if (!hash) continue;
      const pattern = `idcache:${brandId}:idhash:*:${hash}`;
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        for (const key of keys) {
          // Defence in depth: only delete keys inside THIS brand's idcache namespace.
          if (!key.startsWith(`idcache:${brandId}:`)) continue;
          deleted += await this.redis.del(key);
        }
      } while (cursor !== '0');
    }
    return deleted;
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}
