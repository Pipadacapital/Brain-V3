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
  | 'sms'
  | 'capi_meta'; // Phase 6 — server-to-server conversion passback (Meta CAPI).

/**
 * Purpose drives the transactional carve-out AND the gating consent category.
 *  - 'transactional' → TCCCPR carve-out (consent-exempt).
 *  - 'marketing'     → gates on the `marketing` consent category.
 *  - 'advertising'   → gates on the `advertising` consent category (Phase 6, CAPI).
 *                      Distinct lawful basis from marketing (DPDP purpose-limitation).
 */
export type ContactPurpose = 'transactional' | 'marketing' | 'advertising';

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

/**
 * Whether a channel rides the telecom (phone) stack — DLT + NCPR apply.
 * `capi_meta` is a server-to-server measurement signal, NOT a telecom channel, so
 * DLT/NCPR are skipped (exactly as email skips them).
 */
export function isPhoneChannel(channel: ContactChannel): boolean {
  return channel === 'whatsapp' || channel === 'sms';
}

/**
 * identity-core identifier type for a channel (drives normalization + hashing).
 *
 * NOTE: `capi_meta` is a MULTI-identifier match (email AND phone AND click-ids), so
 * it does NOT map to a single identifier type — the CAPI passback service computes
 * the multi-key Meta match payload itself and keys the consent decision on the
 * order's already-resolved subject_hash. This function returns 'email' by default
 * for `capi_meta` but that value is UNUSED on the CAPI path (documented).
 */
export function identifierTypeForChannel(
  channel: ContactChannel,
): 'email' | 'phone' {
  return channel === 'whatsapp' || channel === 'sms' ? 'phone' : 'email';
}

/**
 * The consent category gating a PURPOSE (replaces the constant GATING_CATEGORY).
 *  - 'advertising' → the `advertising` category (Phase 6, CAPI passback).
 *  - everything else (marketing/messaging) → the `marketing` category.
 *
 * Transactional is exempt before this is ever read. Keeping this a pure function
 * means the engine selects the category per-purpose without forking the gate.
 */
export function gatingCategoryForPurpose(p: ContactPurpose): ConsentCategory {
  if (p === 'advertising') return 'advertising';
  return 'marketing';
}

/**
 * The consent category gating a channel. Retained for backward-compatibility with
 * the marketing/messaging path (marketing category = the lawful basis for commercial
 * communication). New code should use `gatingCategoryForPurpose(purpose)`.
 */
export const GATING_CATEGORY: ConsentCategory = 'marketing';
