/**
 * ConnectorRateLimiter — global, cross-replica per-provider dispatch cap (P1 pre-scale).
 *
 * The due-time work queue made repull dispatch PARALLEL across replicas. Meta and Google enforce
 * APP-level quotas shared across every brand — so without a global cap, N replicas each dispatching
 * a batch can storm a provider into 429s. This is a Redis fixed-window counter per provider, shared
 * by all replicas: `tryAcquire(provider)` admits up to `maxPerWindow` dispatches per `windowMs`,
 * fleet-wide. Over-limit connectors are simply skipped this tick (they stay stamped and re-pull next
 * interval) — protecting the provider without losing the connector.
 *
 * Deterministic tier-0 (no model): INCR + EX, the same primitive as the dedup/retry adapters.
 * Mirrors RedisDedupAdapter's ioredis setup (lazyConnect + explicit connect()).
 */
import { Redis } from 'ioredis';

export interface ProviderLimit {
  maxPerWindow: number;
  windowMs: number;
}

/** Per-provider caps. Conservative for the shared-app-quota providers; generous for per-shop ones. */
export const DEFAULT_PROVIDER_LIMITS: Record<string, ProviderLimit> = {
  meta: { maxPerWindow: 10, windowMs: 60_000 },        // Meta Graph app-level quota (shared)
  google_ads: { maxPerWindow: 10, windowMs: 60_000 },  // Google Ads developer-token daily ops quota
  shopify: { maxPerWindow: 100, windowMs: 60_000 },    // per-shop bucket — generous
  razorpay: { maxPerWindow: 60, windowMs: 60_000 },
  gokwik: { maxPerWindow: 60, windowMs: 60_000 },
};

export interface IConnectorRateLimiter {
  /** True = admitted (under the per-provider cap); false = over limit, skip this dispatch. */
  tryAcquire(provider: string): Promise<boolean>;
}

export class ConnectorRateLimiter implements IConnectorRateLimiter {
  private readonly redis: InstanceType<typeof Redis>;

  constructor(
    redisUrl: string,
    private readonly limits: Record<string, ProviderLimit> = DEFAULT_PROVIDER_LIMITS,
  ) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 2,
    });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async tryAcquire(provider: string): Promise<boolean> {
    const limit = this.limits[provider];
    if (!limit) return true; // unlimited for providers without a configured cap

    const windowIdx = Math.floor(Date.now() / limit.windowMs);
    const key = `connector-ratelimit:${provider}:${windowIdx}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        // First hit in this window — set the TTL so the counter self-expires.
        await this.redis.pexpire(key, limit.windowMs);
      }
      return count <= limit.maxPerWindow;
    } catch {
      // FAIL-OPEN: a Redis blip must not block ingestion. Admit (the per-page 429 backoff inside
      // each client is the second line of defense). A persistent Redis outage is its own alert.
      return true;
    }
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}
