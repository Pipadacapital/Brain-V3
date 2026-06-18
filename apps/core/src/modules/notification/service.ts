/**
 * Notification service interface.
 * All outbound email MUST go through this chokepoint (I-ST05 / ADR-012).
 *
 * D13: can_contact() is now the REAL compliance gate (consent + DLT + NCPR + 9–9 IST
 * window), default-closed. It is the SOLE send gate — no module may call a channel
 * provider (SES/WhatsApp) directly.
 *
 * No module other than this one may call SES directly.
 */

import type {
  ContactChannel,
  ContactPurpose,
  CanContactResult,
} from './internal/compliance/contact-types.js';

export type { ContactChannel, ContactPurpose, CanContactResult };

export interface NotificationService {
  /** Send email verification link. */
  sendVerificationEmail(email: string, rawToken: string, correlationId: string): Promise<void>;

  /** Send password reset link. */
  sendPasswordResetEmail(email: string, rawToken: string, correlationId: string): Promise<void>;

  /** Send invitation link. */
  sendInviteEmail(email: string, rawToken: string, correlationId: string): Promise<void>;

  /**
   * The SOLE outbound send gate (I-ST05). Default-closed: any check that cannot
   * affirmatively resolve granted/approved/cleared/in-window returns `block` (or
   * `queue_pending_window` for the 9–9 IST window). There is NO path where an
   * unknown yields `allow`.
   *
   * Ordered checks: transactional-exempt → hash recipient → consent → DLT (phone) →
   * NCPR/DND (phone) → send-window (9–9 IST).
   *
   * @param recipient raw email/phone — hashed immediately, never stored/logged raw.
   * @param channel   the outbound channel (transactional_email is consent-exempt).
   * @param purpose   'transactional' (TCCCPR carve-out) or 'marketing'.
   */
  canContact(
    recipient: string,
    channel: ContactChannel,
    purpose: ContactPurpose,
  ): Promise<CanContactResult>;
}
