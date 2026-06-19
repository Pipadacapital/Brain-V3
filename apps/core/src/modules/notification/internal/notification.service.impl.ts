/**
 * Notification service implementation.
 *
 * Routes: verify-email → SES, reset-password → SES, invite → SES.
 * can_contact() = pass-through stub for M1 (transactional emails are consent-exempt).
 * No consent/DND/tombstone (Phase 3 defer).
 */

import type { NotificationService } from '../service.js';
import type { EmailAdapter } from './ses-adapter.js';
import { writeSendLog } from './send-log.js';
import { captureDevLink } from './dev-link-capture.js';
import type { CanContactEngine } from './compliance/can-contact.engine.js';
import type {
  ContactChannel,
  ContactPurpose,
  CanContactResult,
} from './compliance/contact-types.js';
import type { AuditWriter } from '@brain/audit';
import { log } from "../../../log.js";

export interface CanContactGateDeps {
  /** The real compliance engine. When absent, canContact HARD-FAILS closed. */
  engine: CanContactEngine;
  /** The brand the gate evaluates against (the chokepoint is brand-scoped). */
  brandId: string;
  /** Audits every gate decision (allow/block/queue) — no raw PII in the payload. */
  audit: AuditWriter;
}

export class NotificationServiceImpl implements NotificationService {
  constructor(
    private readonly emailAdapter: EmailAdapter,
    private readonly appBaseUrl: string,
    /**
     * Compliance gate deps. Optional ONLY so the legacy transactional wiring (which
     * never calls canContact) keeps constructing without the engine. When canContact
     * is invoked WITHOUT these deps it FAILS CLOSED (returns block: unknown) — never
     * a silent allow.
     */
    private readonly gate?: CanContactGateDeps,
  ) {}

  async sendVerificationEmail(email: string, rawToken: string, correlationId: string): Promise<void> {
    const verifyUrl = `${this.appBaseUrl}/verify-email?token=${rawToken}`;
    captureDevLink(email, { type: 'email_verification', token: rawToken, url: verifyUrl, capturedAt: new Date().toISOString() });

    await writeSendLog(null, {
      correlationId,
      recipient: email,
      channel: 'email',
      notificationType: 'email_verification',
      status: 'attempted',
    }, { correlationId });

    try {
      await this.emailAdapter.send({
        to: email,
        subject: 'Verify your email — Brain',
        textBody: [
          'Welcome to Brain!',
          '',
          'Please verify your email address by clicking the link below:',
          verifyUrl,
          '',
          'This link expires in 24 hours.',
          '',
          'If you did not create an account, please ignore this email.',
        ].join('\n'),
        correlationId,
      });

      await writeSendLog(null, {
        correlationId,
        recipient: email,
        channel: 'email',
        notificationType: 'email_verification',
        status: 'sent',
      }, { correlationId });
    } catch (err) {
      await writeSendLog(null, {
        correlationId,
        recipient: email,
        channel: 'email',
        notificationType: 'email_verification',
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      }, { correlationId });
      // Don't throw — email failure should not block registration.
      log.error('Failed to send verification email', { err: { correlationId, error: err } });
    }
  }

  async sendPasswordResetEmail(email: string, rawToken: string, correlationId: string): Promise<void> {
    const resetUrl = `${this.appBaseUrl}/reset-password?token=${rawToken}`;
    captureDevLink(email, { type: 'password_reset', token: rawToken, url: resetUrl, capturedAt: new Date().toISOString() });

    await writeSendLog(null, {
      correlationId,
      recipient: email,
      channel: 'email',
      notificationType: 'password_reset',
      status: 'attempted',
    }, { correlationId });

    try {
      await this.emailAdapter.send({
        to: email,
        subject: 'Reset your password — Brain',
        textBody: [
          'You requested a password reset for your Brain account.',
          '',
          'Click the link below to reset your password:',
          resetUrl,
          '',
          'This link expires in 1 hour.',
          '',
          'If you did not request this, please ignore this email.',
        ].join('\n'),
        correlationId,
      });

      await writeSendLog(null, {
        correlationId,
        recipient: email,
        channel: 'email',
        notificationType: 'password_reset',
        status: 'sent',
      }, { correlationId });
    } catch (err) {
      await writeSendLog(null, {
        correlationId,
        recipient: email,
        channel: 'email',
        notificationType: 'password_reset',
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      }, { correlationId });
      log.error('Failed to send password reset email', { err: { correlationId, error: err } });
    }
  }

  async sendInviteEmail(email: string, rawToken: string, correlationId: string): Promise<void> {
    const inviteUrl = `${this.appBaseUrl}/invite/accept?token=${rawToken}`;
    captureDevLink(email, { type: 'invite', token: rawToken, url: inviteUrl, capturedAt: new Date().toISOString() });

    await writeSendLog(null, {
      correlationId,
      recipient: email,
      channel: 'email',
      notificationType: 'invite',
      status: 'attempted',
    }, { correlationId });

    try {
      await this.emailAdapter.send({
        to: email,
        subject: "You've been invited to Brain",
        textBody: [
          "You've been invited to join a workspace on Brain.",
          '',
          'Click the link below to accept:',
          inviteUrl,
          '',
          'This link expires in 7 days.',
          '',
          'If you did not expect this invitation, please ignore this email.',
        ].join('\n'),
        correlationId,
      });

      await writeSendLog(null, {
        correlationId,
        recipient: email,
        channel: 'email',
        notificationType: 'invite',
        status: 'sent',
      }, { correlationId });
    } catch (err) {
      await writeSendLog(null, {
        correlationId,
        recipient: email,
        channel: 'email',
        notificationType: 'invite',
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      }, { correlationId });
      log.error('Failed to send invite email', { err: { correlationId, error: err } });
    }
  }

  /**
   * The SOLE outbound send gate (I-ST05) — the REAL compliance engine.
   *
   * Default-closed at every layer: a transactional purpose is the only allow-without-
   * consent path; everything else flows through consent → DLT → NCPR → 9–9 IST window.
   * If the gate deps are not wired, this FAILS CLOSED (block: unknown) rather than
   * defaulting open. Every decision is audited (hashed subject only, no raw PII).
   */
  async canContact(
    recipient: string,
    channel: ContactChannel,
    purpose: ContactPurpose,
  ): Promise<CanContactResult> {
    if (!this.gate) {
      // No engine wired → fail closed. NEVER a silent allow.
      // (Transactional callers that must send do NOT route through canContact;
      //  they are the documented TCCCPR carve-out and send directly.)
      if (purpose === 'transactional') {
        return { decision: 'allow', reason: 'transactional_exempt' };
      }
      return { decision: 'block', reason: 'unknown' };
    }

    const decision = await this.gate.engine.evaluate({
      brandId: this.gate.brandId,
      recipient,
      channel,
      purpose,
    });

    // Audit every gate decision — hashed subject only, no raw PII (I-S02).
    try {
      await this.gate.audit.append({
        brand_id: this.gate.brandId,
        actor_id: null,
        actor_role: 'system',
        action: 'notification.can_contact',
        entity_type: 'consent_record',
        entity_id: decision.subjectHash ?? 'transactional',
        payload: {
          decision: decision.decision,
          reason: decision.reason,
          channel,
          purpose,
          subject_hash: decision.subjectHash,
          release_after: decision.releaseAfter ?? null,
        },
      });
    } catch (err) {
      // Auditing must not open the gate, but a block must remain a block.
      log.error('can_contact audit append failed', { err: {
                error: err instanceof Error ? err.message : String(err),
              } });
    }

    const result: CanContactResult = {
      decision: decision.decision,
      reason: decision.reason,
    };
    if (decision.releaseAfter) result.releaseAfter = decision.releaseAfter;
    return result;
  }
}
