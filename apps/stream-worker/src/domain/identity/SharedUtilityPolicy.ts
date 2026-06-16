/**
 * SharedUtilityPolicy — phone-guard suppression rule (D-1).
 *
 * India DTC context: courier/kiosk phones appear across many customers.
 * If an identifier (phone hash) has been linked to > phone_guard_threshold
 * distinct brain_ids in the last suppression_window_days, it is a "shared
 * utility identifier" — suppressing it prevents false merges.
 *
 * This is PURE domain logic — no Postgres, no Kafka imports.
 * The repository layer queries the windowed count and passes it here.
 *
 * Asymmetric failure modes:
 *   Too aggressive (N too low): legitimate repeat customers get split brain_ids
 *     → shattered LTV (recoverable via un-suppress + replay).
 *   Too permissive (N too high): courier phone merges 40+ customers into 1
 *     ghost high-LTV entity → revenue over-attribution (harder to fix).
 *   Default N=10 leans guard-strong (CTO FINDING-1 D-1).
 */

/** Result of the phone-guard evaluation. */
export type PhoneGuardDecision =
  | { action: 'eligible' }           // identifier may be used as a merge key
  | { action: 'suppress'; reason: string }   // too many distinct brain_ids → exclude from merge
  | { action: 'already_suppressed'; suppressedUntil: Date };  // previously flagged, still active

export class SharedUtilityPolicy {
  /**
   * Evaluate whether an identifier (phone hash) may be used as a merge key.
   *
   * @param distinctBrainIdCount  Current windowed distinct brain_id count for this identifier.
   * @param threshold             Brand's phone_guard_threshold (DEFAULT 10).
   * @param suppressedUntil       If previously suppressed, the suppression expiry (or null).
   * @param now                   Current timestamp (for suppression expiry check).
   * @returns                     PhoneGuardDecision — eligible, suppress, or already_suppressed.
   */
  evaluate(
    distinctBrainIdCount: number,
    threshold: number,
    suppressedUntil: Date | null,
    now: Date = new Date(),
  ): PhoneGuardDecision {
    // Check active suppression first
    if (suppressedUntil !== null && suppressedUntil > now) {
      return { action: 'already_suppressed', suppressedUntil };
    }

    // Windowed count exceeds threshold → suppress
    if (distinctBrainIdCount > threshold) {
      return {
        action: 'suppress',
        reason: `identifier linked to ${distinctBrainIdCount} distinct brain_ids > threshold ${threshold}`,
      };
    }

    return { action: 'eligible' };
  }

  /**
   * Compute the suppressed_until timestamp for a newly suppressed identifier.
   * = now + suppression_window_days.
   */
  computeSuppressedUntil(now: Date, windowDays: number): Date {
    const until = new Date(now);
    until.setDate(until.getDate() + windowDays);
    return until;
  }
}
