// SPEC: 0.5
/**
 * @brain/platform-flags — Redis ADAPTER for FlagStorePort (hexagonal, driver-thin).
 *
 * Follows the @brain/metric-engine analytics-cache convention: NO ioredis import
 * anywhere in this package — RedisFlagClient is a minimal STRUCTURAL interface
 * that ioredis.Redis satisfies at runtime, and the composition root
 * (apps/core/src/main.ts) injects its SINGLE shared ioredis instance. This file
 * is the only place allowed to talk to the Redis client for flags.
 *
 * Durability note: flags are stored WITHOUT TTL. If the Redis keyspace is ever
 * flushed, every flag reverts to unset = DISABLED — which is exactly the §0.5
 * fail-closed default, so a flush is safe (features turn OFF, never ON).
 */

import type { FlagStorePort } from '../domain/flag-service.js';

/**
 * Minimal Redis client surface (structurally compatible with ioredis.Redis).
 * The variadic `set` matches the ioredis overload family; the adapter calls it
 * with exactly (key, value).
 */
export interface RedisFlagClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
}

export class RedisFlagStoreAdapter implements FlagStorePort {
  constructor(private readonly redis: RedisFlagClient) {}

  /** Errors PROPAGATE — the domain service is the fail-closed layer (reads → false). */
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  /** Durable SET (no TTL). Errors PROPAGATE — an admin write must fail loudly. */
  async set(key: string, value: string): Promise<void> {
    await this.redis.set(key, value);
  }
}
