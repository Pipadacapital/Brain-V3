/**
 * RedisDedupAdapter — C3 Replay Protection: Redis short-TTL event-ID dedup set.
 *
 * Maintains processed Razorpay event_id values in a Redis key with TTL = replay
 * window + processing margin (default: 10 minutes = 600 seconds).
 *
 * This is a SECURITY control (replay prevention) — SEPARATE from Bronze
 * ON CONFLICT DO NOTHING which is a data-correctness control.
 *
 * Per ADR-RZ-7 / C3:
 *   - Redis SET NX EX 600 on the Razorpay event_id
 *   - Already-present → reject with 409 (duplicate) before any processing
 *   - Created_at older than 5-min window → reject with 400 before Redis check
 *     (short-circuits the Redis round-trip for obviously stale events)
 *
 * Key format: razorpay:dedup:<event_id>
 * No raw PII in the Redis key (event_id is an opaque Razorpay-generated string).
 */

import type { Redis } from 'ioredis';

export const REPLAY_WINDOW_SECONDS = 5 * 60;       // 5-minute age check
export const DEDUP_TTL_SECONDS     = 10 * 60;      // 10-minute Redis TTL (window + margin)

export class RedisDedupAdapter {
  private readonly keyPrefix = 'razorpay:dedup:';

  constructor(private readonly redis: Redis) {}

  /**
   * Check if the event_id has already been processed (replay dedup).
   * Returns true if this is a DUPLICATE (already seen within the TTL window).
   * Returns false if this is a NEW event — and marks it as seen atomically.
   *
   * Uses SET NX EX (atomic: set-if-not-exists with expiry).
   * If Redis is unavailable, FAIL-CLOSED: returns false (allow, do NOT block).
   * The Bronze ON CONFLICT DO NOTHING is the safety net for data correctness.
   *
   * @param eventId  Razorpay event.id from the webhook body (opaque — no PII)
   * @returns        true = duplicate (reject); false = new (allow and mark)
   */
  async isDuplicate(eventId: string): Promise<boolean> {
    const key = `${this.keyPrefix}${eventId}`;
    try {
      // SET key 1 NX EX ttl → returns 'OK' if set (new), null if already exists (duplicate)
      const result = await this.redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
      return result === null; // null → key already existed → duplicate
    } catch {
      // Redis unavailable → fail-open (Bronze dedup is the fallback safety net)
      return false;
    }
  }

  /**
   * Check if the event's created_at timestamp is within the allowed replay window.
   * Events older than REPLAY_WINDOW_SECONDS are rejected as potential replays.
   *
   * @param createdAtUnixSeconds  event.created_at (Unix timestamp in seconds, from Razorpay body)
   * @returns                     true = within window (allow); false = too old (reject)
   */
  static isWithinReplayWindow(createdAtUnixSeconds: number): boolean {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ageSeconds = nowSeconds - createdAtUnixSeconds;
    return ageSeconds <= REPLAY_WINDOW_SECONDS;
  }
}
