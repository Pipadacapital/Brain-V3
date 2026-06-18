/**
 * Contact types — the ubiquitous language of the can_contact() gate.
 *
 * The send chokepoint (I-ST05) classifies every outbound send by channel + purpose.
 * Money is not involved here; this is a pure compliance vocabulary.
 */

import type { ConsentCategory } from '@brain/contracts';

/**
 * Outbound channels passing the gate.
 *  - transactional_email: TCCCPR transactional carve-out — consent-EXEMPT (documented).
 *  - marketing_email:     marketing consent required; NCPR not applicable (email is
 *                         not a telecom registry channel).
 *  - whatsapp:            Phase-1 Scheduled Delivery Channel — phone; DLT + NCPR apply.
 *  - sms:                 Phase-3 seam — phone; DLT + NCPR apply. Slots in unchanged.
 */
export type ContactChannel =
  | 'transactional_email'
  | 'marketing_email'
  | 'whatsapp'
  | 'sms';

/** Purpose drives the transactional carve-out. */
export type ContactPurpose = 'transactional' | 'marketing';

/** The three terminal decisions of the gate. */
export type ContactDecision = 'allow' | 'block' | 'queue_pending_window';

/** Every reason the gate can return — each maps 1:1 to an ordered check. */
export type ContactReason =
  // allow reasons
  | 'transactional_exempt'
  | 'allowed'
  // block reasons (all default-closed)
  | 'consent_absent'
  | 'consent_withdrawn'
  | 'dlt_unregistered'
  | 'ncpr_dnd'
  | 'unknown'
  // queue reason
  | 'out_of_window';

export interface CanContactResult {
  decision: ContactDecision;
  reason: ContactReason;
  /**
   * ISO-8601 timestamp when a queue_pending_window item is eligible to flush
   * (the next 09:00 IST). Present ONLY when decision === 'queue_pending_window'.
   */
  releaseAfter?: string;
}

/** Whether a channel rides the telecom (phone) stack — DLT + NCPR apply. */
export function isPhoneChannel(channel: ContactChannel): boolean {
  return channel === 'whatsapp' || channel === 'sms';
}

/** identity-core identifier type for a channel (drives normalization + hashing). */
export function identifierTypeForChannel(
  channel: ContactChannel,
): 'email' | 'phone' {
  return channel === 'transactional_email' || channel === 'marketing_email'
    ? 'email'
    : 'phone';
}

/**
 * The consent category gating a channel. Marketing/messaging channels gate on the
 * `marketing` category (the lawful basis for commercial communication). Returned
 * for non-transactional channels only; transactional is exempt before this is read.
 */
export const GATING_CATEGORY: ConsentCategory = 'marketing';
