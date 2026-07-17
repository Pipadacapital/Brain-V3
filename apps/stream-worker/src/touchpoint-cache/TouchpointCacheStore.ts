// SPEC: A.4
/**
 * TouchpointCacheStore — the Redis zset PORT + ioredis adapter for the real-time
 * touchpoint cache (SPEC: A.4).
 *
 * The cache holds, per DETERMINISTIC brain_id, the last N touchpoints in a sorted set:
 *   key    = `{brand_id}:tp:{brain_id}`   (tenant-first, §0.5 — via touchpointCacheKey())
 *   score  = event timestamp in ms
 *   member = compact JSON `{type, channel, url_path, ts, session_id}`
 *
 * INTENT-LEVEL PORT (not raw Redis verbs): the two write intents each run as a single
 * atomic Redis MULTI so a partial write can never leave the zset over the cap or without a
 * TTL. A structural port (no ioredis import leaking to callers) lets the service be unit-
 * tested with an in-memory double — the A4.* tests and the p99 benchmark inject a fake.
 *
 * CACHE, NOT TRUTH: every op is best-effort. Failures are swallowed by the CONSUMER
 * (fail-safe, Kafka offset still commits) — journey APIs fall back to Iceberg (A.4).
 */
import { Redis } from 'ioredis';

/** One touchpoint to append: score is event-ts-ms, member is the compact JSON string. */
export interface TouchpointEntry {
  /** Event timestamp in ms (the zset score). */
  score: number;
  /** Compact JSON member: `{type, channel, url_path, ts, session_id}`. */
  member: string;
}

/**
 * The touchpoint-cache surface the service depends on (DIP). Intent methods, not raw verbs,
 * so the atomic MULTI (append+cap+ttl / union+cap+ttl+del) stays inside the adapter.
 */
export interface ITouchpointCacheStore {
  /**
   * Append one touchpoint, cap the zset to `maxLen` (newest — highest score — kept), and
   * refresh the sliding TTL — ALL in one atomic round trip.
   */
  appendCapped(
    key: string,
    entry: TouchpointEntry,
    maxLen: number,
    ttlSeconds: number,
  ): Promise<void>;

  /**
   * Merge invalidation (A.4): union the absorbed zset into the survivor (keeping the MAX score
   * for any duplicate member = latest sighting), cap the survivor to `maxLen`, refresh its TTL,
   * and DELETE the absorbed key — ALL in one atomic round trip.
   */
  mergeInto(
    survivorKey: string,
    absorbedKey: string,
    maxLen: number,
    ttlSeconds: number,
  ): Promise<void>;

  // ── inspection (tests / debugging only) ─────────────────────────────────────
  /** Number of members in the zset (0 if absent). */
  card(key: string): Promise<number>;
  /** Remaining TTL in seconds (-2 = no key, -1 = no expiry). */
  ttl(key: string): Promise<number>;
  /** Members ascending by score with their scores (oldest → newest). */
  membersAsc(key: string): Promise<TouchpointEntry[]>;
}

/**
 * ioredis-backed adapter. Mirrors the ConnectorRateLimiter's lifecycle (lazyConnect + explicit
 * connect()/quit(), owned by main.ts). Every write is a MULTI so cap + TTL are inseparable
 * from the insert.
 */
export class RedisTouchpointCacheStore implements ITouchpointCacheStore {
  private readonly redis: InstanceType<typeof Redis>;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
    });
  }

  /** Explicitly connect (lazyConnect=true). Call once before the consumer starts. */
  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async appendCapped(
    key: string,
    entry: TouchpointEntry,
    maxLen: number,
    ttlSeconds: number,
  ): Promise<void> {
    // ZADD (upsert; identical member keeps highest via GT-less default overwrite) →
    // ZREMRANGEBYRANK 0 -(maxLen+1) trims the LOWEST-scored (oldest) beyond the cap →
    // EXPIRE refreshes the 30d sliding window. One MULTI = atomic, one round trip.
    await this.redis
      .multi()
      .zadd(key, entry.score, entry.member)
      .zremrangebyrank(key, 0, -(maxLen + 1))
      .expire(key, ttlSeconds)
      .exec();
  }

  async mergeInto(
    survivorKey: string,
    absorbedKey: string,
    maxLen: number,
    ttlSeconds: number,
  ): Promise<void> {
    // ZUNIONSTORE dest=survivor over {survivor, absorbed} AGGREGATE MAX (a duplicate member
    // keeps the later ts) → cap → refresh TTL → DEL the absorbed key. Atomic MULTI.
    await this.redis
      .multi()
      .zunionstore(survivorKey, 2, survivorKey, absorbedKey, 'AGGREGATE', 'MAX')
      .zremrangebyrank(survivorKey, 0, -(maxLen + 1))
      .expire(survivorKey, ttlSeconds)
      .del(absorbedKey)
      .exec();
  }

  async card(key: string): Promise<number> {
    return this.redis.zcard(key);
  }

  async ttl(key: string): Promise<number> {
    return this.redis.ttl(key);
  }

  async membersAsc(key: string): Promise<TouchpointEntry[]> {
    const flat = await this.redis.zrange(key, 0, -1, 'WITHSCORES');
    const out: TouchpointEntry[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      out.push({ member: flat[i]!, score: Number(flat[i + 1]) });
    }
    return out;
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}
