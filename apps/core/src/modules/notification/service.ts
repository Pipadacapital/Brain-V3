/**
 * Notification service interface.
 * All outbound email MUST go through this chokepoint (I-ST05 / ADR-012).
 *
 * M1 scope: send_log + SES transactional adapter + can_contact() pass-through stub.
 * Consent/DND/tombstone/WhatsApp: Phase 3 defer.
 *
 * No module other than this one may call SES directly.
 */

export interface NotificationService {
  /** Send email verification link. */
  sendVerificationEmail(email: string, rawToken: string, correlationId: string): Promise<void>;

  /** Send password reset link. */
  sendPasswordResetEmail(email: string, rawToken: string, correlationId: string): Promise<void>;

  /** Send invitation link. */
  sendInviteEmail(email: string, rawToken: string, correlationId: string): Promise<void>;

  /**
   * Check if user can be contacted.
   * M1 stub: transactional emails are consent-exempt (TCCCPR).
   * Returns true always for M1 transactional email.
   */
  canContact(email: string, channel: 'transactional_email'): Promise<boolean>;
}
