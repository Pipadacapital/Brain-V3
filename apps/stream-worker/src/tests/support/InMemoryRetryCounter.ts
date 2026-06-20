/**
 * InMemoryRetryCounter — test double for IRetryCounter (T2-8).
 *
 * Behaves exactly like the old per-instance in-memory Map the consumers used before the durable
 * RetryCounterAdapter, so existing DLQ/retry tests exercise the same within-process counting WITHOUT
 * needing Redis. Durability-across-restart is proven separately against the real adapter.
 */
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';

export class InMemoryRetryCounter implements IRetryCounter {
  private readonly counts = new Map<string, number>();

  private key(scope: string, partition: number, offset: string): string {
    return `${scope}:${partition}:${offset}`;
  }

  async increment(scope: string, partition: number, offset: string): Promise<number> {
    const k = this.key(scope, partition, offset);
    const next = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, next);
    return next;
  }

  async reset(scope: string, partition: number, offset: string): Promise<void> {
    this.counts.delete(this.key(scope, partition, offset));
  }
}
