/**
 * catalog/healthSafety.ts — TS lookup for the 7-state health → 3-state safety mapping.
 *
 * ADR-CM-5: The persisted column is the truth; this map is a TS lookup, not a DB join.
 * State→safety table (plan §2):
 *   Healthy       → safe
 *   Delayed       → degraded
 *   RateLimited   → degraded
 *   Failed        → blocked
 *   Disconnected  → blocked
 *   TokenExpired  → blocked
 *   Disabled      → blocked
 */

export type HealthState =
  | 'Healthy'
  | 'Delayed'
  | 'Failed'
  | 'Disconnected'
  | 'RateLimited'
  | 'TokenExpired'
  | 'Disabled';

export type SafetyRating = 'safe' | 'degraded' | 'blocked';

export const HEALTH_TO_SAFETY: Readonly<Record<HealthState, SafetyRating>> = {
  Healthy: 'safe',
  Delayed: 'degraded',
  RateLimited: 'degraded',
  Failed: 'blocked',
  Disconnected: 'blocked',
  TokenExpired: 'blocked',
  Disabled: 'blocked',
} as const;

/**
 * Map a persisted health_state to the recommendation safety rating.
 * The column is the truth; this function is the read path.
 */
export function mapHealthToSafety(healthState: HealthState): SafetyRating {
  return HEALTH_TO_SAFETY[healthState];
}
