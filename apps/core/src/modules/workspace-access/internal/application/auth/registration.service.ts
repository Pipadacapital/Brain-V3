/**
 * RegistrationService — user registration + register-and-auto-login.
 *
 * Owns: register, registerAndStartSession (+ the shared registerInternal core).
 *
 * SECURITY INVARIANTS (preserved verbatim):
 *  - NN-5: argon2id hash ALWAYS runs (no enumeration / timing oracle).
 *  - MA-15: existing-user verification re-issue is fire-and-forget.
 *  - I-ST05: email delivery goes through the notification module only.
 *  - I-S09: no plaintext token in DB — only token_hash.
 *  - Auto-login mints a session ONLY for a genuinely-new user via SessionService.issueSession.
 */

import argon2 from 'argon2';

import type { DbPool, DbClient, QueryContext } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import type { NotificationService } from '../../../../notification/service.js';

import type { AppUser } from '../../domain/auth/entities.js';
import { AppUserRepository } from '../../infrastructure/repositories/app-user.repository.js';
import { EmailVerificationRepository } from '../../infrastructure/repositories/email-verification.repository.js';
import { log } from '../../../../../log.js';

import {
  type ActiveContext,
  EMPTY_CONTEXT,
  ARGON2_PARAMS,
  generateToken,
  maskEmail,
  EMAIL_VERIFY_EXPIRY_MS,
  ACCESS_TOKEN_EXPIRY_SECS,
} from './shared.js';
import type { SessionService } from './session.service.js';

export class RegistrationService {
  /**
   * @param pool         — GUC-middleware-wrapped pool for all standard queries.
   * @param audit        — Audit writer.
   * @param notification — Notification service.
   * @param sessions     — SessionService (for the auto-login session-minting primitive).
   */
  constructor(
    private readonly pool: DbPool,
    private readonly audit: AuditWriter,
    private readonly notification: NotificationService,
    private readonly sessions: SessionService,
  ) {}

  // ── Register ───────────────────────────────────────────────────────────────

  async register(
    email: string,
    password: string,
    correlationId: string,
  ): Promise<{ userId: string; message: string; code?: 'INVITE_PENDING' }> {
    const client = await this.pool.connect();
    try {
      const result = await this.registerInternal(client, email, password, correlationId);
      return {
        userId: result.user.id,
        message: 'Registration successful. Please verify your email.',
        ...(result.invitePending ? { code: 'INVITE_PENDING' as const } : {}),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Register a user, then auto-login by minting a real authenticated session
   * (feat-onboarding-ux, Deliverable 1). The session is issued via the SAME
   * issueSession() primitive used by login() — no bypass, no client-set token.
   *
   * Security contract:
   *  - A session is minted ONLY for a genuinely-new user (created=true). For an
   *    email collision (created=false) NO session is issued — the BFF returns the
   *    same JSON body minus the Set-Cookie. The httpOnly Set-Cookie is unreadable
   *    cross-origin, so the visible body stays enumeration-safe (NN-5).
   *  - The new user lands with EMPTY_CONTEXT (no membership yet) → the wizard.
   *  - `user.logged_in` audit is written by issueSession on the created path only.
   */
  async registerAndStartSession(
    email: string,
    password: string,
    ip: string | null,
    userAgent: string | null,
    correlationId: string,
  ): Promise<{
    created: boolean;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    invitePending: boolean;
    user: { id: string; email: string; emailVerifiedAt: Date | null };
    context: ActiveContext;
  }> {
    const client = await this.pool.connect();
    try {
      const result = await this.registerInternal(client, email, password, correlationId);

      if (!result.created) {
        // Email collision — do NOT mint a session (no auto-login for an existing
        // account). The user entity belongs to someone else; never leak it.
        return {
          created: false,
          invitePending: result.invitePending,
          user: { id: result.user.id, email: result.user.email, emailVerifiedAt: result.user.emailVerifiedAt },
          context: EMPTY_CONTEXT,
        };
      }

      // Genuinely-new user — mint a real session via the shared primitive.
      const { accessToken, refreshToken, context } = await this.sessions.issueSession(
        client,
        result.user,
        ip,
        userAgent,
        correlationId,
      );

      return {
        created: true,
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TOKEN_EXPIRY_SECS,
        invitePending: result.invitePending,
        user: { id: result.user.id, email: result.user.email, emailVerifiedAt: result.user.emailVerifiedAt },
        context,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Core register logic shared by register() and registerAndStartSession().
   * Runs on the caller's `client`. Distinguishes created-new vs already-existed
   * (the public register() collapses this to a single generic message — NN-5).
   * Timing is equalized: the argon2 hash always runs; the existing-user path
   * re-issues verification fire-and-forget (MA-15).
   */
  private async registerInternal(
    client: DbClient,
    email: string,
    password: string,
    correlationId: string,
  ): Promise<{ created: boolean; user: AppUser; invitePending: boolean }> {
    const ctx: QueryContext = { correlationId };
    const userRepo = new AppUserRepository(client);
    const emailVerifyRepo = new EmailVerificationRepository(client);

    // Check for existing user (service-layer isolation — no RLS on app_user).
    const existing = await userRepo.findByEmail(email, ctx);
    // NN-5: no enumeration — always hash (timing-safe).
    const passwordHash = await argon2.hash(password, ARGON2_PARAMS);

    if (existing) {
      // User already exists — silently re-issue verification email if not yet verified.
      if (!existing.emailVerifiedAt) {
        // MA-15: fire-and-forget to equalize timing (no timing oracle for verified vs unverified).
        const emailCtx = { ...ctx, userId: existing.id };
        Promise.resolve().then(async () => {
          try {
            const { rawToken, tokenHash } = generateToken();
            const expiresAt = new Date(Date.now() + EMAIL_VERIFY_EXPIRY_MS);
            await emailVerifyRepo.insert({ appUserId: existing.id, tokenHash, expiresAt }, emailCtx);
            await this.notification.sendVerificationEmail(existing.email, rawToken, correlationId);
          } catch (err) {
            log.error('register: verification re-issue failed', { err: { correlationId, err } });
          }
        });
      }
      return { created: false, user: existing, invitePending: false };
    }

    // Create the user.
    const emailNormalized = email.toLowerCase().trim();
    const user = await userRepo.insert(
      { email, emailNormalized, passwordHash },
      ctx,
    );

    // DEV CONVENIENCE: local dev has no mail delivery, so a fresh account would be stuck behind
    // the email-verification gate (connectors and other actions require a verified email). Outside
    // production, mark the email verified on registration so dev/test accounts are usable
    // immediately. NEVER in production — real users must verify via the emailed token.
    let emailVerifiedAt = user.emailVerifiedAt;
    if (process.env['NODE_ENV'] !== 'production') {
      emailVerifiedAt = new Date();
      await userRepo.markEmailVerified(user.id, emailVerifiedAt, { ...ctx, userId: user.id });
      log.info('DEV auto-verify: email marked verified on registration (NODE_ENV != production)', { detail: { correlationId } });
    }

    // Issue a verification token.
    const { rawToken, tokenHash } = generateToken();
    const expiresAt = new Date(Date.now() + EMAIL_VERIFY_EXPIRY_MS);
    await emailVerifyRepo.insert(
      { appUserId: user.id, tokenHash, expiresAt },
      { ...ctx, userId: user.id },
    );

    // Send the verification email via notification module (I-ST05 — no direct SMTP).
    await this.notification.sendVerificationEmail(email, rawToken, correlationId);

    // Audit log.
    await this.audit.append({
      brand_id: user.id, // use user.id as brand_id for pre-brand events
      actor_id: user.id,
      actor_role: 'system',
      action: 'user.registered',
      entity_type: 'app_user',
      entity_id: user.id,
      payload: { email_masked: maskEmail(email) },
    });

    // AC-7: Check for pending invite for this email (register-with-pending-invite).
    // A single indexed query; run AFTER the hash for timing equivalence.
    const pendingInvite = await userRepo.findPendingInviteByEmail(email, { ...ctx, userId: user.id });

    // Reflect the (possibly dev-auto-verified) timestamp so the registration response + auto-login
    // session see the verified state without a DB re-read.
    return { created: true, user: { ...user, emailVerifiedAt }, invitePending: pendingInvite !== null };
  }
}
