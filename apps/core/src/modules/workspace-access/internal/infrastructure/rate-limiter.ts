import { log } from "../../../../log.js";

/**
 * RateLimiter — Redis INCR + EXPIRE sliding-window counter (AC-3 / MA-04).
 *
 * FAIL-OPEN: a Redis error is logged but does NOT block login (per plan §4 AC-3).
 * Per-plan: one method, 4 routes, no per-route framework.
 */

export interface RateLimiterResult {
  allowed: boolean;
  retryAfter: number; // seconds until window resets (0 if allowed)
  remaining: number;
}

export interface RedisRateLimitClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

export class RateLimiter {
  constructor(private readonly redis: RedisRateLimitClient) {}

  /**
   * Increment the counter and check against limit.
   * FAIL-OPEN: Redis error → allow, log.
   */
  async check(
    key: string,
    limit: number,
    windowSecs: number,
  ): Promise<RateLimiterResult> {
    try {
      const count = await this.redis.incr(key);
      // Set expiry only on first increment (window starts at first attempt).
      if (count === 1) {
        await this.redis.expire(key, windowSecs);
      }
      const ttl = await this.redis.ttl(key);
      const allowed = count <= limit;
      const retryAfter = allowed ? 0 : (ttl > 0 ? ttl : windowSecs);
      return { allowed, retryAfter, remaining: Math.max(0, limit - count) };
    } catch (err) {
      // FAIL-OPEN: Redis error → allow the request.
      log.error('Redis error — failing open', { err: { key, err } });
      return { allowed: true, retryAfter: 0, remaining: limit };
    }
  }

  /** Reset a key (e.g. on successful login to clear the failure counter). */
  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      log.error('Redis reset error', { err: { key, err } });
    }
  }
}

// ── Rate limit key factories ───────────────────────────────────────────────────
// Structured prefix:scope:discriminator — no raw user input as sole key component.

export function loginFailKeySync(email: string, ip: string): string {
  return `rl:login:${email.toLowerCase().trim()}:${ip}`;
}

export function loginIpKey(ip: string): string {
  return `rl:login_ip:${ip}`;
}

export function forgotPasswordKey(email: string): string {
  return `rl:forgot:${email.toLowerCase().trim()}`;
}

export function registerIpKey(ip: string): string {
  return `rl:register:${ip}`;
}

export function refreshIpKey(ip: string): string {
  return `rl:refresh:${ip}`;
}
