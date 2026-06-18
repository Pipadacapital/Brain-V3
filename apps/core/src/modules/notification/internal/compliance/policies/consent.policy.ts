/**
 * Consent policy — maps a SuppressionResult to a fail-closed gate outcome.
 *
 * Encapsulates the rule "marketing/messaging requires a non-suppressed marketing
 * consent_record" so it is reusable by the engine, the pending_window flush, and any
 * future RPC caller (Single-Primitive: the rule lives here, not in a route).
 */

import type { SuppressionResult } from '@brain/contracts';

export type ConsentOutcome =
  | { blocked: false }
  | { blocked: true; reason: 'consent_absent' | 'consent_withdrawn' };

/**
 * Evaluate a suppression result. Suppressed (no_consent / withdrawn / tombstoned)
 * → blocked. There is no "unknown → allow" path: a SuppressionQuery that cannot
 * affirmatively clear the subject returns suppressed=true by contract.
 */
export function evaluateConsent(supp: SuppressionResult): ConsentOutcome {
  if (!supp.suppressed) return { blocked: false };
  return {
    blocked: true,
    reason: supp.reason === 'no_consent' ? 'consent_absent' : 'consent_withdrawn',
  };
}
