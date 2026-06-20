/**
 * RetryCounterAdapter — DURABLE per-(consumer, partition, offset) retry counter (T2-8).
 *
 * The consumers previously counted retries in an in-memory `Map<partition:offset, number>`. That
 * map dies with the process: a POISON message (one that fails deterministically) would retry up to
 * MAX_RETRY, the pod would crash/restart (OOM, deploy, node drain), the counter would reset to 0,
 * and the message would retry forever — never reaching the DLQ, wedging the partition. This moves
 * the counter to Redis (INCR + TTL) so it SURVIVES restarts and the DLQ guarantee actually holds.
 *
 * Key: `retry-counter:{scope}:{partition}:{offset}` where scope = `{groupId}:{topic}`.
 * The scope is LOAD-BEARING: six consumers read the SAME live topic under DIFFERENT consumer
 * groups. The per-instance Map kept their counts isolated for free; a shared Redis store would
 * collide partition+offset across groups WITHOUT the group in the key. Never drop the scope.
 *
 * TTL: 7 days (matches the dedup slot + Redpanda retention) — long enough that a counter never
 * expires mid-retry, self-cleaning so abandoned keys don't accumulate.
 *
 * Uses ioredis (mirrors RedisDedupAdapter). If Redis is briefly unavailable an INCR throws, the
 * consumer's eachMessage throws, KafkaJS redelivers without committing, and the increment is
 * retried next poll — a transient blip delays, it never silently loses the DLQ bound.
 */
import { Redis } from 'ioredis';

/**
 * The retry-counting surface the consumers depend on (DIP) — increment + reset only. Lets a
 * consumer be unit-tested with an in-memory double instead of standing up Redis, while prod wires
 * the durable RetryCounterAdapter below. connect()/quit() are lifecycle concerns of the concrete
 * adapter (owned by main.ts), deliberately NOT on this interface.
 */
export interface IRetryCounter {
  increment(scope: string, partition: number, offset: string): Promise<number>;
  reset(scope: string, partition: number, offset: string): Promise<void>;
}

/** Retry-counter key TTL — 7 days, matching DEDUP_TTL_SECONDS / topic retention. */
const RETRY_COUNTER_TTL_SECONDS = 7 * 24 * 60 * 60;

export class RetryCounterAdapter implements IRetryCounter {
  private readonly redis: InstanceType<typeof Redis>;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
    });
  }

  /** Explicitly connect (lazyConnect=true). Call once before consumers start. */
  async connect(): Promise<void> {
    await this.redis.connect();
  }

  private key(scope: string, partition: number, offset: string): string {
    return `retry-counter:${scope}:${partition}:${offset}`;
  }

  /**
   * Atomically increment the retry count for this (scope, partition, offset) and return the new
   * value. Sets the TTL on first sight so the key self-cleans.
   * @param scope `{groupId}:{topic}` — keeps same-topic/different-group consumers isolated.
   */
  async increment(scope: string, partition: number, offset: string): Promise<number> {
    const key = this.key(scope, partition, offset);
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, RETRY_COUNTER_TTL_SECONDS);
    }
    return count;
  }

  /** Clear the counter for a (scope, partition, offset) — on success or after DLQ routing. */
  async reset(scope: string, partition: number, offset: string): Promise<void> {
    await this.redis.del(this.key(scope, partition, offset));
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}
