/**
 * ProviderRedisDedupAdapter — provider-scoped Redis dedup for the WebhookPipeline.
 *
 * Fixes the dedup key collision bug in the legacy RedisDedupAdapter:
 *   OLD: hardcoded prefix 'razorpay:dedup:' → Shopflo + WooCommerce collide with Razorpay.
 *   NEW: prefix is '<provider>:dedup:' — tenant-isolated per provider.
 *
 * Semantics mirror the legacy adapter (SET NX EX, fail-open on Redis error).
 * Key format: '<provider>:dedup:<eventId>'.
 * No raw PII in the key (eventId is an opaque deterministic UUID or provider-generated string).
 */

import type { Redis } from 'ioredis';
import { log } from '../../../../log.js';

const REPLAY_WINDOW_SECONDS = 5 * 60;   // 5-minute age check (C3)
const DEDUP_TTL_SECONDS     = 10 * 60;  // 10-minute Redis TTL (window + margin)

export class ProviderRedisDedupAdapter {
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: Redis,
    provider: string,
  ) {
    // Sanitise: lowercase, strip non-alnum/dash (defence-in-depth; provider names are code constants).
    this.keyPrefix = `${provider.toLowerCase().replace(/[^a-z0-9-]/g, '')}:dedup:`;
  }

  /**
   * Returns true if this event_id was already processed (duplicate → reject with 409).
   * Returns false if new — atomically marks it as seen.
   *
   * Fail-open: Redis error → allow (same posture as legacy adapter; age gate + Bronze dedup remain).
   */
  async isDuplicate(eventId: string): Promise<boolean> {
    const key = `${this.keyPrefix}${eventId}`;
    try {
      const result = await this.redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
      return result === null; // null → already existed → duplicate
    } catch (err) {
      log.error('webhook_dedup_redis_down', {
        event: 'redis_unavailable_fail_open',
        prefix: this.keyPrefix,
        err: err instanceof Error ? err.message : String(err),
      });
      return false; // fail-open
    }
  }

  /**
   * Age check: is this event within the allowed replay window?
   * @param createdAtUnixSeconds Unix timestamp in seconds from the provider payload.
   * @returns true = within window (allow); false = too old (reject with 400).
   */
  static isWithinReplayWindow(createdAtUnixSeconds: number): boolean {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return (nowSeconds - createdAtUnixSeconds) <= REPLAY_WINDOW_SECONDS;
  }
}
