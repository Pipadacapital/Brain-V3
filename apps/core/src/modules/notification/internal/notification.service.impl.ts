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

export class NotificationServiceImpl implements NotificationService {
  constructor(
    private readonly emailAdapter: EmailAdapter,
    private readonly appBaseUrl: string,
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
      console.error('[notification] Failed to send verification email', { correlationId, error: err });
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
      console.error('[notification] Failed to send password reset email', { correlationId, error: err });
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
      console.error('[notification] Failed to send invite email', { correlationId, error: err });
    }
  }

  async canContact(_email: string, _channel: 'transactional_email'): Promise<boolean> {
    // M1 stub: transactional emails are consent-exempt under TCCCPR.
    // Phase 3 will add real consent checks, DND checks, DLT registration.
    return true;
  }
}
