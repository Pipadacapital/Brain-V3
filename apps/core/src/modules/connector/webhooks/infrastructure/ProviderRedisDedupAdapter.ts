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
// Redis dedup key TTL. Sized to cover the provider's webhook RETRY window: order webhooks bypass the
// C3 age gate (ageCheckTimestampSeconds=null), so THIS TTL is the only guard against a late retry
// landing a DUPLICATE in append-only Bronze. Shopify retries a webhook for ~48h — the old 10-minute
// TTL let any retry >10min through (observed 2026-07-16: an order event redelivered ~30min later
// landed twice in Bronze). 48h default covers Shopify's full retry window so Bronze stays effectively
// exactly-once (Silver dedups downstream regardless). Env-tunable to trade Redis memory (48h of tiny
// event_id keys per provider) against the dedup window.
const DEDUP_TTL_SECONDS =
  Number(process.env.WEBHOOK_DEDUP_TTL_SECONDS) > 0
    ? Number(process.env.WEBHOOK_DEDUP_TTL_SECONDS)
    : 48 * 60 * 60; // 48h — Shopify's webhook retry window

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
   * Release (un-mark) a dedup key previously claimed by isDuplicate().
   *
   * isDuplicate() atomically marks the key seen BEFORE the pipeline's Kafka produce; if that
   * produce then FAILS, the provider's retry would hit the already-set key → 409 → the event is
   * NEVER produced (permanent loss). The pipeline calls release() on produce failure so the
   * retry re-produces. Fail-open on Redis error (same posture as isDuplicate): worst case the
   * retry 409s until the key TTLs out — never worse than the pre-release behaviour.
   */
  async release(eventId: string): Promise<void> {
    const key = `${this.keyPrefix}${eventId}`;
    try {
      await this.redis.del(key);
    } catch (err) {
      log.error('webhook_dedup_release_failed', {
        event: 'redis_unavailable_fail_open',
        prefix: this.keyPrefix,
        err: err instanceof Error ? err.message : String(err),
      });
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
