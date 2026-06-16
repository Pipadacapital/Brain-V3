/**
 * RedisDedupAdapter — first-line dedup via Redis SET NX EX (D-3).
 *
 * Key: dedup:{brand_id}:{event_id}  (tenant-prefixed, I-S01)
 * TTL: 7 days (matches Redpanda topic retention, §architecture-plan D-3)
 *
 * SET NX (Not eXists) semantics:
 *   - Returns 'OK'  → key was absent (first sight of this event) → proceed to write
 *   - Returns null  → key already present (duplicate) → skip write, commit offset
 *
 * Uses ioredis (existing dep in apps/core) — CacheAdapter pattern (ADR-004).
 */
import { Redis } from 'ioredis';
import { buildDedupKey, DEDUP_TTL_SECONDS } from '../../domain/bronze/DedupPolicy.js';

export interface DedupResult {
  /** true = first sight (proceed to write); false = duplicate (skip write) */
  isFirstSight: boolean;
}

export class RedisDedupAdapter {
  private readonly redis: InstanceType<typeof Redis>;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
    });
  }

  /**
   * Attempt to claim the dedup slot for (brand_id, event_id).
   * Uses SET NX EX — atomic; no separate GET+SET race.
   *
   * @returns { isFirstSight: true } if this is the first time we've seen this
   *          event (the SET succeeded), { isFirstSight: false } if it's a dup.
   */
  async checkAndClaim(brandId: string, eventId: string): Promise<DedupResult> {
    const key = buildDedupKey(brandId, eventId);
    // SET key '1' NX EX ttl — returns 'OK' on success, null on collision
    const result = await this.redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
    return { isFirstSight: result === 'OK' };
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}
