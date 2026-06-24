/**
 * Auth application service — thin FACADE.
 *
 * The former monolithic auth.service has been decomposed (CQ-5) into four cohesive
 * application services under ./auth/:
 *   - RegistrationService  — register, registerAndStartSession
 *   - SessionService       — login, refreshSession, rotateRefreshToken, logout,
 *                            mintSessionToken, parseJwt, validateSession, getCurrentUser,
 *                            isEmailVerified (+ the issueSession primitive)
 *   - UserLifecycleService — suspendUser, reactivateUser, resetPassword, verifyEmail,
 *                            forgotPassword
 *   - ContextService       — resolveActiveContext, switchBrandContext
 *
 * The refresh-token rotation transaction (BEGIN/COMMIT/ROLLBACK + SELECT FOR UPDATE)
 * now lives in UserSessionRepository.rotateRefreshTokenUnitOfWork — the application layer
 * no longer hand-rolls that transaction.
 *
 * This class preserves the original constructor signature, public method surface and
 * module-level exports so existing callers/DI keep working unchanged. Each method delegates
 * to the cohesive service that owns it — no behaviour change.
 *
 * SECURITY INVARIANTS (enforced in the delegate services; see each file):
 *  - NN-5 argon2id + no-enumeration; NN-3 session-revocation checks; I-S09 token_hash only;
 *    I-ST05 email via notification module; AC-1 refresh rotation + family-wipe; AC-2 bulk revoke;
 *    MA-* multi-brand switch + timing-oracle defenses.
 */

import type { Pool } from 'pg';

import type { DbPool } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import type { NotificationService } from '../../../notification/service.js';

import type { AppUser, JwtClaims } from '../domain/auth/entities.js';

import {
  type ActiveContext,
  type ResolvableMembership,
  type AuthServiceConfig,
  AuthError,
  ARGON2_PARAMS,
  assertArgon2Params,
  selectActiveContext,
  maskEmail,
} from './auth/shared.js';
import { RegistrationService, type EmitDomainEvent } from './auth/registration.service.js';
import { SessionService } from './auth/session.service.js';
import { UserLifecycleService } from './auth/user-lifecycle.service.js';
import { ContextService } from './auth/context.service.js';

// Re-exports — preserve the original public module surface for existing callers + tests.
export {
  type ActiveContext,
  type ResolvableMembership,
  type AuthServiceConfig,
  AuthError,
  ARGON2_PARAMS,
  assertArgon2Params,
  selectActiveContext,
  maskEmail,
};

export class AuthService {
  private readonly registration: RegistrationService;
  private readonly sessions: SessionService;
  private readonly lifecycle: UserLifecycleService;
  private readonly context: ContextService;

  /**
   * @param pool       — GUC-middleware-wrapped pool for all standard queries.
   * @param audit      — Audit writer.
   * @param notification — Notification service.
   * @param config     — Auth config (signing secret).
   * @param rawPgPool  — Optional raw pg.Pool (no GUC middleware) for the rotateRefreshToken /
   *                     suspend / reactivate paths that need explicit BEGIN/COMMIT.
   * @param emitEvent  — Optional M1 lifecycle event emitter (EV-2). Threaded to
   *                     RegistrationService for the user.registered event.
   */
  constructor(
    pool: DbPool,
    audit: AuditWriter,
    notification: NotificationService,
    config: AuthServiceConfig,
    rawPgPool?: Pool,
    emitEvent?: EmitDomainEvent,
  ) {
    // Wire the cohesive services. ContextService needs the JWT-minting primitive (MA-01:
    // switchBrandContext mints directly); SessionService owns it. SessionService needs
    // ContextService for refreshSession; RegistrationService needs SessionService for auto-login.
    this.context = new ContextService(pool, audit, (userId, jti, ctx) =>
      this.sessions.mintSessionToken(userId, jti, ctx),
    );
    this.sessions = new SessionService(pool, audit, config, this.context, rawPgPool);
    this.registration = new RegistrationService(pool, audit, notification, this.sessions, emitEvent);
    this.lifecycle = new UserLifecycleService(pool, audit, notification, rawPgPool);
  }

  // ── Register ───────────────────────────────────────────────────────────────

  register(
    email: string,
    password: string,
    correlationId: string,
  ): Promise<{ userId: string; message: string; code?: 'INVITE_PENDING' }> {
    return this.registration.register(email, password, correlationId);
  }

  registerAndStartSession(
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
    return this.registration.registerAndStartSession(email, password, ip, userAgent, correlationId);
  }

  // ── Verify Email ───────────────────────────────────────────────────────────

  verifyEmail(rawToken: string, correlationId: string): Promise<void> {
    return this.lifecycle.verifyEmail(rawToken, correlationId);
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  login(
    email: string,
    password: string,
    ip: string | null,
    userAgent: string | null,
    correlationId: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: Pick<AppUser, 'id' | 'email' | 'emailVerifiedAt'>;
    context: ActiveContext;
  }> {
    return this.sessions.login(email, password, ip, userAgent, correlationId);
  }

  // ── Rotating Refresh Token ───────────────────────────────────────────────────

  rotateRefreshToken(
    rawRefreshToken: string,
    ip: string | null,
    userAgent: string | null,
    correlationId: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    return this.sessions.rotateRefreshToken(rawRefreshToken, ip, userAgent, correlationId);
  }

  // ── Session context (brand/role) ─────────────────────────────────────────────

  mintSessionToken(userId: string, jti: string, context: ActiveContext): string {
    return this.sessions.mintSessionToken(userId, jti, context);
  }

  resolveActiveContext(userId: string, correlationId: string, preferredWorkspaceId?: string): Promise<ActiveContext> {
    return this.context.resolveActiveContext(userId, correlationId, preferredWorkspaceId);
  }

  refreshSession(
    userId: string,
    jti: string,
    correlationId: string,
    preferredWorkspaceId?: string,
  ): Promise<{ accessToken: string; expiresIn: number; context: ActiveContext }> {
    return this.sessions.refreshSession(userId, jti, correlationId, preferredWorkspaceId);
  }

  switchBrandContext(
    userId: string,
    jti: string,
    fromBrandId: string | null,
    workspaceId: string,
    requestedBrandId: string,
    correlationId: string,
  ): Promise<{ accessToken: string; expiresIn: number; context: ActiveContext }> {
    return this.context.switchBrandContext(userId, jti, fromBrandId, workspaceId, requestedBrandId, correlationId);
  }

  // ── Logout ─────────────────────────────────────────────────────────────────

  logout(jti: string, userId: string, correlationId: string, scopeAll = false): Promise<void> {
    return this.sessions.logout(jti, userId, correlationId, scopeAll);
  }

  // ── Member lifecycle ─────────────────────────────────────────────────────────

  suspendUser(
    appUserId: string,
    actorId: string,
    organizationId: string,
    brandId: string | null,
    correlationId: string,
  ): Promise<{ sessionsRevoked: number }> {
    return this.lifecycle.suspendUser(appUserId, actorId, organizationId, brandId, correlationId);
  }

  reactivateUser(
    appUserId: string,
    actorId: string,
    organizationId: string,
    brandId: string | null,
    correlationId: string,
  ): Promise<void> {
    return this.lifecycle.reactivateUser(appUserId, actorId, organizationId, brandId, correlationId);
  }

  // ── Password ─────────────────────────────────────────────────────────────────

  forgotPassword(email: string, correlationId: string): Promise<void> {
    return this.lifecycle.forgotPassword(email, correlationId);
  }

  resetPassword(rawToken: string, newPassword: string, correlationId: string): Promise<void> {
    return this.lifecycle.resetPassword(rawToken, newPassword, correlationId);
  }

  // ── Validate Session / current user ──────────────────────────────────────────

  validateSession(userId: string, jti: string, correlationId: string): Promise<boolean> {
    return this.sessions.validateSession(userId, jti, correlationId);
  }

  getCurrentUser(userId: string, correlationId: string): Promise<AppUser | null> {
    return this.sessions.getCurrentUser(userId, correlationId);
  }

  isEmailVerified(userId: string, correlationId: string): Promise<boolean> {
    return this.sessions.isEmailVerified(userId, correlationId);
  }

  // ── Parse and verify JWT ─────────────────────────────────────────────────────

  parseJwt(token: string): JwtClaims | null {
    return this.sessions.parseJwt(token);
  }
}
