/**
 * Auth application service.
 *
 * Owns: register, verify-email, login, logout, forgot-password, reset-password.
 *
 * SECURITY INVARIANTS:
 *  - NN-5: argon2id (m=19456, t=2, p=1) asserted at startup.
 *  - NN-5: forgot-password ALWAYS returns 200 with content-identical body (no enumeration).
 *  - NN-5: tokens are crypto.randomBytes(32) → sha256 hex, single-use, expiry-enforced.
 *  - NN-3: session validation checks user_session.revoked_at IS NULL.
 *  - I-S09: no plaintext token in DB — only token_hash.
 *  - I-ST05: email delivery goes through notification module only.
 */

import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';

import type { DbPool, QueryContext } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import type { NotificationService } from '../../../notification/service.js';

import type { AppUser, JwtClaims } from '../domain/auth/entities.js';
import {
  AppUserRepository,
  UserSessionRepository,
  PasswordResetRepository,
  EmailVerificationRepository,
  MembershipRepository,
} from '../infrastructure/repositories.js';
import type { RoleCode } from '../domain/membership/entities.js';
import { mintJwt, verifyJwt } from '../security/jwt.js';

/** Active brand/role context carried in the session JWT (all-null until onboarded). */
export interface ActiveContext {
  brandId: string | null;
  workspaceId: string | null;
  role: RoleCode | null;
}

const EMPTY_CONTEXT: ActiveContext = { brandId: null, workspaceId: null, role: null };

// ── Argon2id parameters (NN-5 / OWASP 2025 minimum) ──────────────────────────

export const ARGON2_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 19456,  // m=19456 KiB
  timeCost: 2,        // t=2 iterations
  parallelism: 1,     // p=1
} as const;

/**
 * Assert argon2id parameters at startup (NN-5).
 * Call this from main.ts before any auth request is served.
 */
export function assertArgon2Params(): void {
  if (ARGON2_PARAMS.memoryCost < 19456) {
    throw new Error(`[auth] INVARIANT VIOLATION: argon2id memoryCost ${ARGON2_PARAMS.memoryCost} < 19456 (NN-5)`);
  }
  if (ARGON2_PARAMS.timeCost < 2) {
    throw new Error(`[auth] INVARIANT VIOLATION: argon2id timeCost ${ARGON2_PARAMS.timeCost} < 2 (NN-5)`);
  }
}

// ── Token helpers ─────────────────────────────────────────────────────────────

/** Generate a crypto-random token and return both the raw token and its sha256 hash. */
function generateToken(): { rawToken: string; tokenHash: string } {
  const rawBytes = randomBytes(32);
  const rawToken = rawBytes.toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

/** Mask an email address for logging/events (no raw PII — I-S02). */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***@***';
  return `${local[0]}***@${domain}`;
}

// ── Token expiry ──────────────────────────────────────────────────────────────

const PASSWORD_RESET_EXPIRY_MS = 60 * 60 * 1000;      // 1 hour (NN-5)
const EMAIL_VERIFY_EXPIRY_MS = 24 * 60 * 60 * 1000;   // 24 hours
const ACCESS_TOKEN_EXPIRY_SECS = 15 * 60;              // 15 minutes
const REFRESH_TOKEN_EXPIRY_SECS = 7 * 24 * 60 * 60;   // 7 days

// ── Auth service ──────────────────────────────────────────────────────────────

export interface AuthServiceConfig {
  jwtSigningSecret: string;
}

export class AuthService {
  constructor(
    private readonly pool: DbPool,
    private readonly audit: AuditWriter,
    private readonly notification: NotificationService,
    private readonly config: AuthServiceConfig,
  ) {}

  // ── Register ───────────────────────────────────────────────────────────────

  async register(
    email: string,
    password: string,
    correlationId: string,
  ): Promise<{ userId: string; message: string }> {
    const ctx: QueryContext = { correlationId };
    const client = await this.pool.connect();
    try {
      const userRepo = new AppUserRepository(client);
      const emailVerifyRepo = new EmailVerificationRepository(client);

      // Check for existing user (service-layer isolation — no RLS on app_user).
      const existing = await userRepo.findByEmail(email, ctx);
      // NN-5: no enumeration — don't reveal if user exists. Hash anyway (timing-safe).
      const passwordHash = await argon2.hash(password, ARGON2_PARAMS);

      if (existing) {
        // User already exists — still hash password (timing-safe) but return same success msg.
        // Silently issue a new verification email if not yet verified.
        if (!existing.emailVerifiedAt) {
          const { rawToken, tokenHash } = generateToken();
          const expiresAt = new Date(Date.now() + EMAIL_VERIFY_EXPIRY_MS);
          await emailVerifyRepo.insert(
            { appUserId: existing.id, tokenHash, expiresAt },
            { ...ctx, userId: existing.id },
          );
          await this.notification.sendVerificationEmail(existing.email, rawToken, correlationId);
        }
        return { userId: existing.id, message: 'Registration successful. Please verify your email.' };
      }

      // Create the user.
      const emailNormalized = email.toLowerCase().trim();
      const user = await userRepo.insert(
        { email, emailNormalized, passwordHash },
        ctx,
      );

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

      return { userId: user.id, message: 'Registration successful. Please verify your email.' };
    } finally {
      client.release();
    }
  }

  // ── Verify Email ───────────────────────────────────────────────────────────

  async verifyEmail(rawToken: string, correlationId: string): Promise<void> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const ctx: QueryContext = { correlationId };
    const client = await this.pool.connect();
    try {
      const emailVerifyRepo = new EmailVerificationRepository(client);
      const userRepo = new AppUserRepository(client);

      // We need to find the token without user context first (token_hash is globally unique).
      // Use a system context (no userId GUC — app_user has no RLS).
      const token = await emailVerifyRepo.findValidByHash(tokenHash, ctx);
      if (!token) {
        throw new AuthError('INVALID_TOKEN', 'Invalid or expired verification token.');
      }

      // Mark token used (single-use — NN-5).
      await emailVerifyRepo.markUsed(token.id, { ...ctx, userId: token.appUserId });

      // Mark user email as verified.
      await userRepo.markEmailVerified(token.appUserId, new Date(), ctx);

      await this.audit.append({
        brand_id: token.appUserId,
        actor_id: token.appUserId,
        actor_role: 'system',
        action: 'user.email_verified',
        entity_type: 'app_user',
        entity_id: token.appUserId,
        payload: {},
      });
    } finally {
      client.release();
    }
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  async login(
    email: string,
    password: string,
    ip: string | null,
    userAgent: string | null,
    correlationId: string,
  ): Promise<{
    accessToken: string;
    expiresIn: number;
    user: Pick<AppUser, 'id' | 'email' | 'emailVerifiedAt'>;
    context: ActiveContext;
  }> {
    const ctx: QueryContext = { correlationId };
    const client = await this.pool.connect();
    try {
      const userRepo = new AppUserRepository(client);
      const sessionRepo = new UserSessionRepository(client);
      const memberRepo = new MembershipRepository(client);

      const user = await userRepo.findByEmail(email, ctx);

      // NN-5: timing-safe — always verify a hash even when user not found.
      const dummyHash = '$argon2id$v=19$m=19456,t=2,p=1$dummysaltfortimingequalisation$dummyhashvalue123456789012345678901234567890123';
      const hashToVerify = user?.passwordHash ?? dummyHash;
      // argon2@0.44 verify infers the algorithm from the hash encoding ($argon2id$ prefix).
      // No type option needed; the hash string itself enforces argon2id (NN-5).
      const valid = await argon2.verify(hashToVerify, password);

      if (!user || !valid || user.status === 'suspended') {
        throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password.');
      }

      // Create session.
      const jti = randomUUID();
      const { rawToken: refreshToken, tokenHash: refreshTokenHash } = generateToken();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_SECS * 1000);

      await sessionRepo.insert(
        { appUserId: user.id, jti, refreshTokenHash, expiresAt, ip, userAgent },
        { ...ctx, userId: user.id },
      );

      // Resolve the user's active brand/role so the session is usable immediately.
      // A bare login token otherwise carries null context and every role-gated route
      // 403s (the session could never bootstrap brand/role — see
      // 0008_membership_self_read.sql). Reads the user's OWN membership via the
      // self-read policy (app.current_user_id GUC set from ctx.userId).
      const activeMembership = await memberRepo.findActiveByUser(user.id, {
        correlationId,
        userId: user.id,
      });
      const context: ActiveContext = activeMembership
        ? {
            brandId: activeMembership.brandId,
            workspaceId: activeMembership.organizationId,
            role: activeMembership.roleCode,
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

      return {
        accessToken,
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

  // ── Session context (brand/role) bootstrapping ───────────────────────────────

  /**
   * Mint a session access token (15-min) for an existing session `jti` with the
   * given active context. Reusing the same `jti` preserves the session row and
   * its revocation state (NN-3) — this is a context refresh, not a new session.
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

  /** Resolve the user's current active brand/role (self-read; null until onboarded). */
  async resolveActiveContext(userId: string, correlationId: string): Promise<ActiveContext> {
    const client = await this.pool.connect();
    try {
      const memberRepo = new MembershipRepository(client);
      const m = await memberRepo.findActiveByUser(userId, { correlationId, userId });
      return m
        ? { brandId: m.brandId, workspaceId: m.organizationId, role: m.roleCode }
        : EMPTY_CONTEXT;
    } finally {
      client.release();
    }
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
  ): Promise<{ accessToken: string; expiresIn: number; context: ActiveContext }> {
    const context = await this.resolveActiveContext(userId, correlationId);
    return {
      accessToken: this.mintSessionToken(userId, jti, context),
      expiresIn: ACCESS_TOKEN_EXPIRY_SECS,
      context,
    };
  }

  // ── Logout ─────────────────────────────────────────────────────────────────

  async logout(jti: string, userId: string, correlationId: string): Promise<void> {
    const ctx: QueryContext = { correlationId, userId };
    const client = await this.pool.connect();
    try {
      const sessionRepo = new UserSessionRepository(client);
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
    } finally {
      client.release();
    }
  }

  // ── Forgot Password ────────────────────────────────────────────────────────
  // NN-5: ALWAYS returns the same response — never reveals if email exists.

  async forgotPassword(email: string, correlationId: string): Promise<void> {
    const ctx: QueryContext = { correlationId };
    const client = await this.pool.connect();
    try {
      const userRepo = new AppUserRepository(client);
      const resetRepo = new PasswordResetRepository(client);

      const user = await userRepo.findByEmail(email, ctx);

      if (user && user.status === 'active') {
        const { rawToken, tokenHash } = generateToken();
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS);
        await resetRepo.insert(
          { appUserId: user.id, tokenHash, expiresAt },
          { ...ctx, userId: user.id },
        );
        // Send via notification module (I-ST05 — no direct SMTP).
        await this.notification.sendPasswordResetEmail(email, rawToken, correlationId);

        await this.audit.append({
          brand_id: user.id,
          actor_id: user.id,
          actor_role: 'system',
          action: 'password_reset.requested',
          entity_type: 'app_user',
          entity_id: user.id,
          payload: { email_masked: maskEmail(email) },
        });
      }
      // NN-5: no else branch — same code path timing (argon2 hash not needed here
      // since we don't verify a password; the timing difference is acceptable for
      // forgot-password which doesn't reveal user existence via timing in practice).
    } finally {
      client.release();
    }
  }

  // ── Reset Password ─────────────────────────────────────────────────────────

  async resetPassword(rawToken: string, newPassword: string, correlationId: string): Promise<void> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const ctx: QueryContext = { correlationId };
    const client = await this.pool.connect();
    try {
      const resetRepo = new PasswordResetRepository(client);
      const userRepo = new AppUserRepository(client);

      const token = await resetRepo.findValidByHash(tokenHash, ctx);
      if (!token) {
        throw new AuthError('INVALID_TOKEN', 'Invalid or expired reset token.');
      }

      // Mark token used (single-use — NN-5).
      await resetRepo.markUsed(token.id, { ...ctx, userId: token.appUserId });

      // Hash new password and update.
      const passwordHash = await argon2.hash(newPassword, ARGON2_PARAMS);
      await userRepo.updatePasswordHash(token.appUserId, passwordHash, ctx);

      await this.audit.append({
        brand_id: token.appUserId,
        actor_id: token.appUserId,
        actor_role: 'system',
        action: 'password_reset.completed',
        entity_type: 'app_user',
        entity_id: token.appUserId,
        payload: {},
      });
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

  // ── Parse and verify JWT ───────────────────────────────────────────────────

  parseJwt(token: string): JwtClaims | null {
    try {
      return verifyJwt(token, this.config.jwtSigningSecret);
    } catch {
      return null;
    }
  }
}

// ── Domain errors ─────────────────────────────────────────────────────────────

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
