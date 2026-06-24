/**
 * SessionService — session lifecycle + JWT minting/parsing.
 *
 * Owns: login, issueSession (the single session-minting primitive), rotateRefreshToken,
 *       refreshSession, logout, mintSessionToken, parseJwt, validateSession,
 *       getCurrentUser, isEmailVerified.
 *
 * SECURITY INVARIANTS (preserved verbatim):
 *  - NN-5: login timing-safe — always verifies a hash even when the user is not found.
 *  - NN-3: validateSession checks user_session.revoked_at IS NULL; logout sets revoked_at.
 *  - AC-1: refresh-token rotation runs inside the SessionRepository unit-of-work
 *          (SELECT FOR UPDATE; replay → family-wipe). The application layer no longer
 *          hand-rolls the transaction — it maps the outcome to audit + AuthError.
 *  - AC-2: scope=all logout revokes all sessions for the user.
 */

import { createHash, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool } from 'pg';

import type { DbPool, DbClient, QueryContext } from '@brain/db';
import type { AuditWriter } from '@brain/audit';

import type { AppUser, JwtClaims } from '../../domain/auth/entities.js';
import { AppUserRepository } from '../../infrastructure/repositories/app-user.repository.js';
import { UserSessionRepository } from '../../infrastructure/repositories/user-session.repository.js';
import { MembershipRepository } from '../../infrastructure/repositories/membership.repository.js';
import { OrganizationRepository } from '../../infrastructure/repositories/organization.repository.js';
import type { OnboardingStatus } from '../../domain/organization/entities.js';
import { mintJwt, verifyJwt } from '../../security/jwt.js';

import {
  type ActiveContext,
  type AuthServiceConfig,
  AuthError,
  EMPTY_CONTEXT,
  generateToken,
  ACCESS_TOKEN_EXPIRY_SECS,
  REFRESH_TOKEN_EXPIRY_SECS,
} from './shared.js';
import type { ContextService } from './context.service.js';

export class SessionService {
  /**
   * @param pool       — GUC-middleware-wrapped pool for all standard queries.
   * @param audit      — Audit writer.
   * @param config     — Auth config (signing secret).
   * @param context    — ContextService (active-context resolution for refreshSession).
   * @param rawPgPool  — Optional raw pg.Pool (no GUC middleware) for the
   *                     rotateRefreshToken path that needs explicit BEGIN/COMMIT.
   */
  constructor(
    private readonly pool: DbPool,
    private readonly audit: AuditWriter,
    private readonly config: AuthServiceConfig,
    private readonly context: ContextService,
    private readonly rawPgPool?: Pool,
  ) {}

  // ── Login ──────────────────────────────────────────────────────────────────

  async login(
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
    const ctx: QueryContext = { correlationId };
    const client = await this.pool.connect();
    try {
      const userRepo = new AppUserRepository(client);

      const user = await userRepo.findByEmail(email, ctx);

      // NN-5: timing-safe — always verify a hash even when user not found.
      const dummyHash = '$argon2id$v=19$m=19456,t=2,p=1$dummysaltfortimingequalisation$dummyhashvalue123456789012345678901234567890123';
      const hashToVerify = user?.passwordHash ?? dummyHash;
      const valid = await argon2.verify(hashToVerify, password);

      if (!user || !valid || user.status === 'suspended') {
        throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password.', 401);
      }

      // Single session-minting primitive — shared with registerAndStartSession (auto-login).
      const { accessToken, refreshToken, context } = await this.issueSession(
        client,
        user,
        ip,
        userAgent,
        correlationId,
      );

      return {
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TOKEN_EXPIRY_SECS,
        user: {
          id: user.id,
          email: user.email,
          emailVerifiedAt: user.emailVerifiedAt,
        },
        context,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Mint a brand-new session for `user` (login = new family root, AC-1) and write the
   * `user.logged_in` audit. The SINGLE session-minting primitive — called by both
   * login() and RegistrationService.registerAndStartSession() (auto-login).
   *
   * Resolves the user's active brand/role context (EMPTY_CONTEXT for a just-registered
   * user with no membership yet). Runs on the caller's `client` so it shares the pooled
   * connection's GUC scope.
   */
  async issueSession(
    client: DbClient,
    user: Pick<AppUser, 'id'>,
    ip: string | null,
    userAgent: string | null,
    correlationId: string,
  ): Promise<{ accessToken: string; refreshToken: string; context: ActiveContext }> {
    const sessionRepo = new UserSessionRepository(client);
    const memberRepo = new MembershipRepository(client);
    const orgRepo = new OrganizationRepository(client);

    // Create session — generate a new UUID for the row id so we can set family_id = id.
    const jti = randomUUID();
    const { rawToken: refreshToken, tokenHash: refreshTokenHash } = generateToken();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_SECS * 1000);

    // Insert session without family_id first, then set family_id = id in the same txn.
    // We use the session id as the family_id root (AC-1 login = new family root).
    const session = await sessionRepo.insert(
      { appUserId: user.id, jti, refreshTokenHash, expiresAt, ip, userAgent },
      { correlationId, userId: user.id },
    );
    // Set family_id = own id (root of a new family).
    await sessionRepo.setFamilyIdToSelf(session.id, { correlationId, userId: user.id });

    // Resolve the user's active brand/role so the session is usable immediately.
    const activeMembership = await memberRepo.findActiveByUser(user.id, {
      correlationId,
      userId: user.id,
    });

    let onboardingStatus: OnboardingStatus | null = null;
    if (activeMembership) {
      const org = await orgRepo.findById(activeMembership.organizationId, {
        correlationId,
        workspaceId: activeMembership.organizationId,
      });
      onboardingStatus = org?.onboardingStatus ?? null;
    }

    const context: ActiveContext = activeMembership
      ? {
          brandId: activeMembership.brandId,
          workspaceId: activeMembership.organizationId,
          role: activeMembership.roleCode,
          onboardingStatus,
        }
      : EMPTY_CONTEXT;

    // Mint JWT (ADR-006 compatible claims — D0.1).
    const accessToken = this.mintSessionToken(user.id, jti, context);

    await this.audit.append({
      brand_id: user.id,
      actor_id: user.id,
      actor_role: 'system',
      action: 'user.logged_in',
      entity_type: 'user_session',
      entity_id: jti,
      payload: { ip_prefix: ip ? ip.split('.').slice(0, 3).join('.') + '.0' : null },
    });

    return { accessToken, refreshToken, context };
  }

  // ── Rotating Refresh Token (AC-1 / MA-01 / MA-03) ─────────────────────────
  /**
   * Exchange a raw refresh token for a new (access_token, refresh_token) pair.
   *
   * The transaction (SELECT ... FOR UPDATE, replay detection, family-wipe, rotation INSERT,
   * context resolution) is owned by UserSessionRepository.rotateRefreshTokenUnitOfWork — the
   * application layer no longer hand-rolls BEGIN/COMMIT. This method maps the unit-of-work
   * outcome to the post-COMMIT audit appends + AuthError, preserving prior behaviour exactly.
   *
   * Replay detection: matched row revoked_at/used_at NOT NULL → family-wipe → 401 SESSION_REVOKED.
   * jti UNIQUE conflict on INSERT → 401 SESSION_CONFLICT (concurrent race defense).
   * Not found → 401 INVALID_TOKEN; expired → 401 INVALID_TOKEN.
   */
  async rotateRefreshToken(
    rawRefreshToken: string,
    ip: string | null,
    userAgent: string | null,
    correlationId: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');

    // Raw pg.Pool for explicit BEGIN/COMMIT (owned by the repository unit-of-work). beginRlsTxn
    // drops to brain_app with fail-closed NIL GUCs; the session is found by TOKEN (the credential)
    // via the SECURITY DEFINER find_session_for_rotation() auth primitive (user_session is
    // RLS-scoped by app.current_user_id, unknown until the lookup), then the user GUC is set from
    // the resolved app_user_id so the revoke/insert run under the user.
    if (!this.rawPgPool) {
      throw new AuthError('CONFIGURATION_ERROR', 'Raw pg pool not provided — token rotation unavailable.', 500);
    }

    const newRefreshToken = generateToken();
    const newJti = randomUUID();

    const outcome = await UserSessionRepository.rotateRefreshTokenUnitOfWork(
      this.rawPgPool,
      { tokenHash, ip, userAgent, correlationId, refreshTokenExpirySecs: REFRESH_TOKEN_EXPIRY_SECS },
      newRefreshToken,
      newJti,
      (userId, jti, ctx) => this.mintSessionToken(userId, jti, ctx),
    );

    switch (outcome.kind) {
      case 'not_found':
        throw new AuthError('INVALID_TOKEN', 'Invalid refresh token.', 401);

      case 'expired':
        throw new AuthError('INVALID_TOKEN', 'Refresh token has expired.', 401);

      case 'conflict':
        throw new AuthError('SESSION_CONFLICT', 'Session conflict detected. Please re-login.', 401);

      case 'replayed':
        await this.audit.append({
          brand_id: outcome.appUserId,
          actor_id: outcome.appUserId,
          actor_role: 'system',
          action: 'sessions.bulk_revoked',
          entity_type: 'user_session',
          entity_id: outcome.entityId,
          payload: { reason: 'refresh_replay', count: outcome.wipeCount, family_id: outcome.familyId },
        });
        throw new AuthError('SESSION_REVOKED', 'Refresh token was already used. All sessions revoked.', 401);

      case 'rotated':
        await this.audit.append({
          brand_id: outcome.appUserId,
          actor_id: outcome.appUserId,
          actor_role: 'system',
          action: 'session.rotated',
          entity_type: 'user_session',
          entity_id: outcome.newJti,
          payload: { old_jti: outcome.oldJti, family_id: outcome.familyId },
        });
        return {
          accessToken: outcome.accessToken,
          refreshToken: outcome.refreshToken,
          expiresIn: ACCESS_TOKEN_EXPIRY_SECS,
        };
    }
  }

  // ── Session context (brand/role) bootstrapping ───────────────────────────────

  /**
   * Mint a session access token for an existing session `jti` with the given active
   * context. Reusing the same `jti` preserves the session row and its revocation state
   * (NN-3) — this is a context refresh, not a new session.
   */
  mintSessionToken(userId: string, jti: string, context: ActiveContext): string {
    const nowSecs = Math.floor(Date.now() / 1000);
    const claims: JwtClaims = {
      sub: userId,
      brand_id: context.brandId,
      workspace_id: context.workspaceId,
      role: context.role,
      jti,
      iat: nowSecs,
      exp: nowSecs + ACCESS_TOKEN_EXPIRY_SECS,
    };
    return mintJwt(claims, this.config.jwtSigningSecret);
  }

  /**
   * Re-mint a session token for the current `jti` with the user's freshly-resolved
   * active context. Called after onboarding (workspace+brand creation) so the
   * SAME session picks up brand_id/role without forcing a re-login.
   */
  async refreshSession(
    userId: string,
    jti: string,
    correlationId: string,
    preferredWorkspaceId?: string,
  ): Promise<{ accessToken: string; expiresIn: number; context: ActiveContext }> {
    const context = await this.context.resolveActiveContext(userId, correlationId, preferredWorkspaceId);
    return {
      accessToken: this.mintSessionToken(userId, jti, context),
      expiresIn: ACCESS_TOKEN_EXPIRY_SECS,
      context,
    };
  }

  // ── Logout ─────────────────────────────────────────────────────────────────

  async logout(
    jti: string,
    userId: string,
    correlationId: string,
    scopeAll = false,
  ): Promise<void> {
    const ctx: QueryContext = { correlationId, userId };
    const client = await this.pool.connect();
    try {
      const sessionRepo = new UserSessionRepository(client);

      if (scopeAll) {
        // AC-2: scope=all — revoke all sessions for this user.
        const count = await sessionRepo.revokeAllForUser(userId, ctx);
        await this.audit.append({
          brand_id: userId,
          actor_id: userId,
          actor_role: 'system',
          action: 'sessions.bulk_revoked',
          entity_type: 'user_session',
          entity_id: userId,
          payload: { reason: 'logout_all', count },
        });
      } else {
        await sessionRepo.revoke(jti, ctx);
        await this.audit.append({
          brand_id: userId,
          actor_id: userId,
          actor_role: 'system',
          action: 'session.revoked',
          entity_type: 'user_session',
          entity_id: jti,
          payload: {},
        });
      }
    } finally {
      client.release();
    }
  }

  // ── Validate Session ───────────────────────────────────────────────────────
  // NN-3: called in a preHandler on every protected route.

  async validateSession(
    userId: string,
    jti: string,
    correlationId: string,
  ): Promise<boolean> {
    const ctx: QueryContext = { correlationId, userId };
    const client = await this.pool.connect();
    try {
      const sessionRepo = new UserSessionRepository(client);
      const session = await sessionRepo.findActiveByJti(jti, ctx);
      return session !== null;
    } finally {
      client.release();
    }
  }

  // ── Get Current User ───────────────────────────────────────────────────────

  async getCurrentUser(userId: string, correlationId: string): Promise<AppUser | null> {
    const ctx: QueryContext = { correlationId };
    const client = await this.pool.connect();
    try {
      const userRepo = new AppUserRepository(client);
      return userRepo.findById(userId, ctx);
    } finally {
      client.release();
    }
  }

  /**
   * Authoritative email-verification check for the soft-gate (feat-onboarding-ux,
   * Deliverable 2). Does a DB self-read (the JWT carries no email_verified claim, and
   * a mid-session verify must take effect immediately — no stale-claim bug).
   * FAIL-CLOSED: returns false when the user is not found.
   */
  async isEmailVerified(userId: string, correlationId: string): Promise<boolean> {
    const user = await this.getCurrentUser(userId, correlationId);
    return user?.emailVerifiedAt != null;
  }

  // ── Parse and verify JWT ───────────────────────────────────────────────────

  parseJwt(token: string): JwtClaims | null {
    try {
      return verifyJwt(token, this.config.jwtSigningSecret);
    } catch {
      return null;
    }
  }
}
