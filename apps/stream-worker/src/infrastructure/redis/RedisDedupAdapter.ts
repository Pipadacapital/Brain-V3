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
   * Explicitly connect to Redis (required when lazyConnect=true).
   * Call once before the first checkAndClaim in tests or standalone jobs.
   * (ADR-0015 WS2: the Bronze-writing consumers are gone; this adapter is retained as the
   * identifier-cache seam for the Silver identity stage — doc 18 PR 3.1.)
   */
  async connect(): Promise<void> {
    await this.redis.connect();
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

  /**
   * Read-only fast-path check (R-08): has this (brand, event) already been claimed? Returns true if the
   * dedup slot is present. This is ONLY an optimization to skip a known-duplicate's DB round-trip — the
   * DURABLE dedup is the bronze_events PK (ON CONFLICT DO NOTHING). A miss claims NOTHING, so a write
   * that fails afterwards can be safely reprocessed (no false "seen" slot to silently drop the event).
   */
  async check(brandId: string, eventId: string): Promise<boolean> {
    const key = buildDedupKey(brandId, eventId);
    try {
      return (await this.redis.exists(key)) === 1;
    } catch {
      // Redis hiccup (not connected / reconnecting): this is ONLY a fast-path optimization. Treat as a
      // cache MISS (false) so processing proceeds to the DURABLE dedup (bronze_events PK ON CONFLICT).
      // NEVER throw here — a transient Redis error must not wedge the consumer on this offset.
      return false;
    }
  }

  /**
   * Claim the dedup slot AFTER a durable Bronze write succeeds (R-08 — NEVER before). Plain SET EX (not
   * NX): the write already committed, so this only primes the fast-path for future sightings. Best-effort
   * by contract — a Redis hiccup here must not fail an already-durable event (the PK still dedups).
   */
  async claim(brandId: string, eventId: string): Promise<void> {
    const key = buildDedupKey(brandId, eventId);
    try {
      await this.redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS);
    } catch {
      // Best-effort by contract: the Bronze write already committed (durable PK dedup). A Redis hiccup
      // priming the fast-path slot must NOT fail an already-durable event. Swallow and move on.
    }
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}
