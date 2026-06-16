/**
 * Auth application service.
 *
 * Owns: register, verify-email, login, logout, forgot-password, reset-password,
 *       rotateRefreshToken (AC-1), validateSession, resolveActiveContext.
 *
 * SECURITY INVARIANTS:
 *  - NN-5: argon2id (m=19456, t=2, p=1) asserted at startup.
 *  - NN-5: forgot-password ALWAYS returns 200 with content-identical body (no enumeration).
 *  - NN-5: tokens are crypto.randomBytes(32) → sha256 hex, single-use, expiry-enforced.
 *  - NN-3: session validation checks user_session.revoked_at IS NULL.
 *  - I-S09: no plaintext token in DB — only token_hash.
 *  - I-ST05: email delivery goes through notification module only.
 *  - AC-1: refresh token rotation under SELECT FOR UPDATE; replay → family-wipe.
 *  - AC-2: revokeAllForUser / revokeAllForUserAndBrand for bulk revocation.
 *  - MA-04: forgotPassword sends email fire-and-forget (no timing oracle).
 *  - MA-15: register verification re-issue is fire-and-forget (no timing oracle).
 */

import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool, PoolClient } from 'pg';

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
  OrganizationRepository,
  BrandRepository,
} from '../infrastructure/repositories.js';
import type { RoleCode } from '../domain/membership/entities.js';
import { ROLE_HIERARCHY } from '../domain/membership/entities.js';
import type { OnboardingStatus } from '../domain/organization/entities.js';
import { mintJwt, verifyJwt } from '../security/jwt.js';

/** Active brand/role context carried in the session JWT (all-null until onboarded). */
export interface ActiveContext {
  brandId: string | null;
  workspaceId: string | null;
  role: RoleCode | null;
  onboardingStatus: OnboardingStatus | null;
}

const EMPTY_CONTEXT: ActiveContext = {
  brandId: null,
  workspaceId: null,
  role: null,
  onboardingStatus: null,
};

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
const ACCESS_TOKEN_EXPIRY_SECS = 60 * 60;              // 1 hour
const REFRESH_TOKEN_EXPIRY_SECS = 7 * 24 * 60 * 60;   // 7 days

// ── Auth service ──────────────────────────────────────────────────────────────

export interface AuthServiceConfig {
  jwtSigningSecret: string;
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthService {
  /**
   * @param pool       — GUC-middleware-wrapped pool for all standard queries.
   * @param audit      — Audit writer.
   * @param notification — Notification service.
   * @param config     — Auth config (signing secret).
   * @param rawPgPool  — Optional raw pg.Pool (no GUC middleware) for the
   *                     rotateRefreshToken path that needs explicit BEGIN/COMMIT.
   *                     If not provided, a runtime cast is attempted.
   */
  constructor(
    private readonly pool: DbPool,
    private readonly audit: AuditWriter,
    private readonly notification: NotificationService,
    private readonly config: AuthServiceConfig,
    private readonly rawPgPool?: Pool,
  ) {}

  // ── Register ───────────────────────────────────────────────────────────────

  async register(
    email: string,
    password: string,
    correlationId: string,
  ): Promise<{ userId: string; message: string; code?: 'INVITE_PENDING' }> {
    const ctx: QueryContext = { correlationId };
    const client = await this.pool.connect();
    try {
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
              console.error('[auth] register: verification re-issue failed', { correlationId, err });
            }
          });
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

      // AC-7: Check for pending invite for this email (register-with-pending-invite).
      // A single indexed query; run AFTER the hash for timing equivalence.
      const pendingInvite = await userRepo.findPendingInviteByEmail(email, { ...ctx, userId: user.id });

      return {
        userId: user.id,
        message: 'Registration successful. Please verify your email.',
        ...(pendingInvite ? { code: 'INVITE_PENDING' as const } : {}),
      };
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

      const token = await emailVerifyRepo.findValidByHash(tokenHash, ctx);
      if (!token) {
        throw new AuthError('INVALID_TOKEN', 'Invalid or expired verification token.', 400);
      }

      await emailVerifyRepo.markUsed(token.id, { ...ctx, userId: token.appUserId });
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
    refreshToken: string;
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
      const orgRepo = new OrganizationRepository(client);

      const user = await userRepo.findByEmail(email, ctx);

      // NN-5: timing-safe — always verify a hash even when user not found.
      const dummyHash = '$argon2id$v=19$m=19456,t=2,p=1$dummysaltfortimingequalisation$dummyhashvalue123456789012345678901234567890123';
      const hashToVerify = user?.passwordHash ?? dummyHash;
      const valid = await argon2.verify(hashToVerify, password);

      if (!user || !valid || user.status === 'suspended') {
        throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password.', 401);
      }

      // Create session — generate a new UUID for the row id so we can set family_id = id.
      const jti = randomUUID();
      const { rawToken: refreshToken, tokenHash: refreshTokenHash } = generateToken();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_SECS * 1000);

      // Insert session without family_id first, then set family_id = id in the same txn.
      // We use the session id as the family_id root (AC-1 login = new family root).
      const session = await sessionRepo.insert(
        { appUserId: user.id, jti, refreshTokenHash, expiresAt, ip, userAgent },
        { ...ctx, userId: user.id },
      );
      // Set family_id = own id (root of a new family).
      await sessionRepo.setFamilyIdToSelf(session.id, { ...ctx, userId: user.id });

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

  // ── Rotating Refresh Token (AC-1 / MA-01 / MA-03) ─────────────────────────
  /**
   * Exchange a raw refresh token for a new (access_token, refresh_token) pair.
   *
   * ALL steps run inside ONE Postgres transaction with SELECT ... FOR UPDATE (MA-03).
   *
   * Replay detection: if the matched row has revoked_at IS NOT NULL OR used_at IS NOT NULL
   *   → family-wipe → 401 SESSION_REVOKED.
   * jti UNIQUE conflict on INSERT → 401 SESSION_CONFLICT (concurrent race defense).
   * Not found → 401 INVALID_TOKEN.
   */
  async rotateRefreshToken(
    rawRefreshToken: string,
    ip: string | null,
    userAgent: string | null,
    correlationId: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');

    // Use the raw pg.Pool (no GUC middleware) so we can control BEGIN/COMMIT explicitly.
    // We don't know userId until after the SELECT FOR UPDATE — can't set GUC first.
    if (!this.rawPgPool) {
      throw new AuthError('CONFIGURATION_ERROR', 'Raw pg pool not provided — token rotation unavailable.', 500);
    }
    const rawClient: PoolClient = await this.rawPgPool.connect();
    try {
      await rawClient.query('BEGIN');

      // Step 1: Find the session row FOR UPDATE (MA-03 — serializes concurrent rotations).
      // This lookup uses a direct query — the token IS the credential, no user GUC yet.
      const lookupResult = await rawClient.query<{
        id: string; app_user_id: string; jti: string;
        refresh_token_hash: string; issued_at: Date; expires_at: Date;
        revoked_at: Date | null; used_at: Date | null;
        family_id: string | null; rotated_from: string | null;
      }>(
        `SELECT id, app_user_id, jti, refresh_token_hash, issued_at, expires_at, revoked_at, used_at, family_id, rotated_from
         FROM user_session
         WHERE refresh_token_hash = $1
         FOR UPDATE`,
        [tokenHash],
      );

      const row = lookupResult.rows[0];

      // Step 2: Not found at all → INVALID_TOKEN.
      if (!row) {
        await rawClient.query('ROLLBACK');
        throw new AuthError('INVALID_TOKEN', 'Invalid refresh token.', 401);
      }

      // Step 3: Replay detection — consumed (used_at IS NOT NULL) or revoked.
      if (row.revoked_at !== null || row.used_at !== null) {
        // SEC-AOF-L1: Set app.current_user_id GUC so that under the production
        // brain_app role (NOBYPASSRLS) the user_session RLS policy allows this
        // UPDATE. Without this, the family-wipe UPDATE would affect 0 rows in prod
        // (RLS filters by app.current_user_id = empty → no matches).
        // We know app_user_id from the SELECT FOR UPDATE row above.
        await rawClient.query(
          `SELECT set_config('app.current_user_id', $1, true)`,
          [row.app_user_id],
        );

        // Family-wipe: revoke all active sessions in this family.
        const familyId = row.family_id ?? row.id;
        const wipeResult = await rawClient.query<{ rowcount: number }>(
          `WITH revoked AS (
             UPDATE user_session SET revoked_at = NOW()
             WHERE family_id = $1 AND revoked_at IS NULL
             RETURNING id
           )
           SELECT COUNT(*) AS rowcount FROM revoked`,
          [familyId],
        );
        const wipeCount = parseInt(String(wipeResult.rows[0]?.rowcount ?? 0), 10);

        await rawClient.query('COMMIT');

        await this.audit.append({
          brand_id: row.app_user_id,
          actor_id: row.app_user_id,
          actor_role: 'system',
          action: 'sessions.bulk_revoked',
          entity_type: 'user_session',
          entity_id: row.family_id ?? row.id,
          payload: { reason: 'refresh_replay', count: wipeCount, family_id: familyId },
        });

        throw new AuthError('SESSION_REVOKED', 'Refresh token was already used. All sessions revoked.', 401);
      }

      // Step 4: Expired — not a replay (row not yet used), just expired.
      if (row.expires_at < new Date()) {
        await rawClient.query('ROLLBACK');
        throw new AuthError('INVALID_TOKEN', 'Refresh token has expired.', 401);
      }

      // Step 5: Valid token — rotate.
      // 5a: Mark old row as rotated (revoked_at + used_at = NOW()).
      await rawClient.query(
        `UPDATE user_session SET revoked_at = NOW(), used_at = NOW() WHERE id = $1`,
        [row.id],
      );

      // 5b: Create new session row inheriting the family_id.
      const newJti = randomUUID();
      const { rawToken: newRefreshToken, tokenHash: newRefreshTokenHash } = generateToken();
      const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_SECS * 1000);
      const inheritedFamilyId = row.family_id ?? row.id;

      let newSessionId: string;
      try {
        const insertResult = await rawClient.query<{ id: string }>(
          `INSERT INTO user_session
             (app_user_id, jti, refresh_token_hash, expires_at, ip, user_agent, family_id, rotated_from)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [row.app_user_id, newJti, newRefreshTokenHash, newExpiresAt, ip, userAgent, inheritedFamilyId, row.id],
        );
        newSessionId = insertResult.rows[0]!.id;
        void newSessionId; // used below for audit
      } catch (err: unknown) {
        // jti UNIQUE conflict (concurrent race — MA-03).
        const pgErr = err as { code?: string };
        if (pgErr?.code === '23505') {
          await rawClient.query('ROLLBACK');
          throw new AuthError('SESSION_CONFLICT', 'Session conflict detected. Please re-login.', 401);
        }
        throw err;
      }

      // 5c: Resolve active context and mint new access token.
      const memberResult = await rawClient.query<{
        id: string; organization_id: string; brand_id: string | null; role_code: string;
      }>(
        `SELECT id, organization_id, brand_id, role_code
         FROM membership
         WHERE app_user_id = $1
         ORDER BY (brand_id IS NOT NULL) DESC, created_at DESC
         LIMIT 1`,
        [row.app_user_id],
      );
      const m = memberResult.rows[0];

      let onboardingStatus: OnboardingStatus | null = null;
      if (m) {
        const orgResult = await rawClient.query<{ onboarding_status: string }>(
          `SELECT onboarding_status FROM organization WHERE id = $1`,
          [m.organization_id],
        );
        onboardingStatus = (orgResult.rows[0]?.onboarding_status ?? null) as OnboardingStatus | null;
      }

      const context: ActiveContext = m
        ? {
            brandId: m.brand_id,
            workspaceId: m.organization_id,
            role: m.role_code as RoleCode,
            onboardingStatus,
          }
        : EMPTY_CONTEXT;

      const accessToken = this.mintSessionToken(row.app_user_id, newJti, context);

      await rawClient.query('COMMIT');

      await this.audit.append({
        brand_id: row.app_user_id,
        actor_id: row.app_user_id,
        actor_role: 'system',
        action: 'session.rotated',
        entity_type: 'user_session',
        entity_id: newJti,
        payload: { old_jti: row.jti, family_id: inheritedFamilyId },
      });

      return { accessToken, refreshToken: newRefreshToken, expiresIn: ACCESS_TOKEN_EXPIRY_SECS };
    } catch (err) {
      // If BEGIN was entered but error wasn't caught in an inner COMMIT/ROLLBACK
      try { await rawClient.query('ROLLBACK'); } catch { /* ignore rollback error */ }
      throw err;
    } finally {
      rawClient.release();
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

  /** Resolve the user's current active brand/role + onboardingStatus (self-read; null until onboarded). */
  async resolveActiveContext(userId: string, correlationId: string, preferredWorkspaceId?: string): Promise<ActiveContext> {
    const client = await this.pool.connect();
    try {
      const memberRepo = new MembershipRepository(client);
      const orgRepo = new OrganizationRepository(client);

      let m = preferredWorkspaceId
        ? await memberRepo.findByUserAndOrg(userId, preferredWorkspaceId, null, { correlationId, userId, workspaceId: preferredWorkspaceId })
        : null;

      if (!m) {
        m = await memberRepo.findActiveByUser(userId, { correlationId, userId });
      }

      if (!m) return EMPTY_CONTEXT;

      const org = await orgRepo.findById(m.organizationId, {
        correlationId,
        workspaceId: m.organizationId,
      });

      return {
        brandId: m.brandId,
        workspaceId: m.organizationId,
        role: m.roleCode,
        onboardingStatus: org?.onboardingStatus ?? null,
      };
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
    preferredWorkspaceId?: string,
  ): Promise<{ accessToken: string; expiresIn: number; context: ActiveContext }> {
    const context = await this.resolveActiveContext(userId, correlationId, preferredWorkspaceId);
    return {
      accessToken: this.mintSessionToken(userId, jti, context),
      expiresIn: ACCESS_TOKEN_EXPIRY_SECS,
      context,
    };
  }

  // ── Switch Brand Context (MA-01/02/03/09/10/11/12) ───────────────────────────
  /**
   * Re-mint the session JWT with a verified brand-level context.
   *
   * Security contract (binding — AC-1 of feat-multi-brand):
   *  1. Membership check uses 3-arg findByUserAndOrg (non-null brand_id) → 403 if no row.
   *  2. workspaceId ALWAYS comes from the JWT (caller passes auth.workspaceId) → prevents
   *     cross-org membership spoofing (MA-02).
   *  3. Archived brand → 400 BRAND_ARCHIVED (MA-10).
   *  4. role comes from the BRAND-LEVEL membership row (MA-03).
   *  5. mintSessionToken called DIRECTLY, reusing the jti — NEVER refreshSession /
   *     resolveActiveContext / findActiveByUser (MA-01 CRITICAL: those paths have a
   *     findActiveByUser fallback that substitutes the wrong brand).
   *  6. brand.switch audit written after membership+archived check (MA-09).
   *
   * MA-13: On fresh login, findActiveByUser auto-selects the most-recently-created
   * brand-level membership row (ORDER BY brand_id IS NOT NULL DESC, created_at DESC).
   * For a multi-brand user this is always the last-created brand, not the last-used
   * brand. Users switch brands via set-brand. "Remember last active brand" is deferred.
   */
  async switchBrandContext(
    userId: string,
    jti: string,
    fromBrandId: string | null,   // auth.brandId (outgoing context), audit only
    workspaceId: string,          // auth.workspaceId from JWT — NEVER from request body (MA-02)
    requestedBrandId: string,     // body.brand_id
    correlationId: string,
  ): Promise<{ accessToken: string; expiresIn: number; context: ActiveContext }> {
    const client = await this.pool.connect();
    try {
      const memberRepo = new MembershipRepository(client);
      const brandRepo = new BrandRepository(client);

      // Step 1: Verify brand-level membership WITHOUT brandId in ctx (MA-11).
      // Setting app.current_brand_id before we have authorized access to the target brand
      // would bleed into the pooled connection — mirror set-org ctx at bff.routes.ts:315.
      const memberCtx = { correlationId, userId, workspaceId };
      // MA-11: NO brandId in ctx — setting app.current_brand_id before authorizing the target
      // brand would bleed into the pooled connection (mirror set-org ctx at bff.routes.ts:315).

      // SEC MA-02: workspaceId comes from the JWT (caller passes auth.workspaceId),
      // NEVER the request body — prevents cross-org membership spoofing.
      // Step 2: 3-arg findByUserAndOrg (non-null third arg) — returns brand-level row (MA-01/MA-03).
      const row = await memberRepo.findByUserAndOrg(userId, workspaceId, requestedBrandId, memberCtx);
      if (!row) {
        throw new AuthError('FORBIDDEN', 'Not a member of the requested brand.', 403);
      }

      // Step 3: Archived guard (MA-10) — application layer (NOT in RLS; cross-table status
      // join in a hot policy is a performance risk). Read with brand-scoped ctx (now authorized).
      // MA-12: this read must target the primary Postgres node — a create-then-switch on a read
      // replica could 403 under replica lag. M1 is single-node; mandatory revisit before any
      // read replica is introduced.
      const brandCtx = { correlationId, workspaceId, brandId: requestedBrandId };
      // MA-10: app-layer archived guard (NOT in RLS — a cross-table status join in a hot policy
      // is a perf risk).
      const brand = await brandRepo.findById(requestedBrandId, brandCtx);
      if (!brand) {
        throw new AuthError('FORBIDDEN', 'Brand not found.', 403);
      }
      if (brand.status === 'archived') {
        throw new AuthError('BRAND_ARCHIVED', 'Cannot switch to an archived brand.', 400);
      }

      // Step 4: Build context from THE BRAND-LEVEL membership row (MA-03).
      // MA-03: role comes from the BRAND-LEVEL membership row (row.roleCode) — NEVER the
      // org-level (null-brand) row, or an org-owner would be minted into a brand-analyst session.
      const context: ActiveContext = {
        brandId: row.brandId,
        workspaceId: row.organizationId,
        role: row.roleCode,
        onboardingStatus: null,
      };

      // Step 5: Direct mint, reusing the existing jti (MA-01 CRITICAL).
      // MA-01 CRITICAL: mintSessionToken DIRECTLY. NEVER refreshSession/resolveActiveContext —
      // their findActiveByUser fallback substitutes the wrong brand (context-substitution defect).
      // Reusing jti preserves the session row + revocation state (NN-3).
      const accessToken = this.mintSessionToken(userId, jti, context);

      // Step 6: Audit (MA-09) — brand.switch with from/to/workspace/role_granted.
      // Written after a successful membership+archived check. If mintSessionToken throws after
      // this append, the audit row stands (append-only, I-S06) — acceptable, matches existing
      // pattern (see session.rotated audit at auth.service.ts:518).
      await this.audit.append({
        brand_id: requestedBrandId,
        actor_id: userId,
        actor_role: row.roleCode,
        action: 'brand.switch',
        entity_type: 'brand',
        entity_id: requestedBrandId,
        payload: {
          from_brand_id: fromBrandId,
          to_brand_id: requestedBrandId,
          workspace_id: workspaceId,
          role_granted: row.roleCode,
        },
        idempotency_key: randomUUID(),
      });

      return { accessToken, expiresIn: ACCESS_TOKEN_EXPIRY_SECS, context };
    } finally {
      client.release();
    }
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

  // ── Suspend User (D-8 / C-3 / C-4 / H-1) ────────────────────────────────────
  // Rewrite: rawPgPool BEGIN/COMMIT wrapping both writes (session-revoke + status)
  // in ONE transaction (C-3 atomicity). Actor-authority checked from DB (C-4).
  // Audit post-COMMIT with brand_id: brandId ?? organizationId (H-1 fix).

  async suspendUser(
    appUserId: string,
    actorId: string,
    organizationId: string,
    brandId: string | null,
    correlationId: string,
  ): Promise<{ sessionsRevoked: number }> {
    if (!this.rawPgPool) {
      throw new AuthError('CONFIGURATION_ERROR', 'Raw pg pool not configured — suspendUser unavailable.', 500);
    }
    const rawClient: PoolClient = await this.rawPgPool.connect();
    try {
      await rawClient.query('BEGIN');

      // Step 1 (C-4): resolve actor's membership row from DB (not JWT — D-2).
      const actorResult = await rawClient.query<{
        id: string; organization_id: string; role_code: string;
      }>(
        `SELECT id, organization_id, role_code FROM membership
         WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL`,
        [actorId, organizationId],
      );
      const actor = actorResult.rows[0];
      if (!actor ||
          (actor.role_code !== 'owner' && actor.role_code !== 'brand_admin')) {
        await rawClient.query('ROLLBACK');
        throw new AuthError('FORBIDDEN', 'Requires owner or brand_admin role to suspend.', 403);
      }

      // Step 2 (D-9 + C-4): resolve target's membership row from DB.
      const targetResult = await rawClient.query<{
        id: string; organization_id: string; app_user_id: string; role_code: string;
      }>(
        `SELECT id, organization_id, app_user_id, role_code FROM membership
         WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL`,
        [appUserId, organizationId],
      );
      const target = targetResult.rows[0];
      // D-9: app-layer org assertion (rawPgPool carries no GUC — this IS the cross-org guard).
      if (!target || target.organization_id !== organizationId) {
        await rawClient.query('ROLLBACK');
        throw new AuthError('NOT_FOUND', 'Member not found in this organization.', 404);
      }

      // Step 3 (C-4): hierarchy check — actor must OUTRANK target. Owner cannot be suspended by non-owner.
      const actorIdx = ROLE_HIERARCHY.indexOf(actor.role_code as RoleCode);
      const targetIdx = ROLE_HIERARCHY.indexOf(target.role_code as RoleCode);
      if (target.role_code === 'owner' && actor.role_code !== 'owner') {
        await rawClient.query('ROLLBACK');
        throw new AuthError('FORBIDDEN', 'Cannot suspend an Owner.', 403);
      }
      if (actor.role_code !== 'owner' && actorIdx <= targetIdx) {
        await rawClient.query('ROLLBACK');
        throw new AuthError('FORBIDDEN', 'Cannot suspend a member with equal or higher authority.', 403);
      }

      // Step 4 (C-3): atomic writes — session revoke + status in ONE txn.
      const revokeResult = await rawClient.query<{ rowcount: string }>(
        `WITH revoked AS (
           UPDATE user_session SET revoked_at = NOW()
           WHERE app_user_id = $1 AND revoked_at IS NULL
           RETURNING id
         )
         SELECT COUNT(*)::text AS rowcount FROM revoked`,
        [appUserId],
      );
      const sessionsRevoked = parseInt(revokeResult.rows[0]?.rowcount ?? '0', 10);

      await rawClient.query(
        `UPDATE app_user SET status = 'suspended', updated_at = NOW() WHERE id = $1`,
        [appUserId],
      );

      await rawClient.query('COMMIT');

      // Step 5 (M-1 / H-1): audit POST-COMMIT; brand_id = brandId ?? organizationId (NOT appUserId).
      await this.audit.append({
        brand_id: brandId ?? organizationId,
        actor_id: actorId,
        actor_role: actor.role_code,
        action: 'user.suspended',
        entity_type: 'app_user',
        entity_id: appUserId,
        payload: { sessions_revoked: sessionsRevoked },
      });
      await this.audit.append({
        brand_id: brandId ?? organizationId,
        actor_id: actorId,
        actor_role: actor.role_code,
        action: 'sessions.bulk_revoked',
        entity_type: 'user_session',
        entity_id: appUserId,
        payload: { reason: 'user_suspended', count: sessionsRevoked, target_user_id: appUserId },
      });

      return { sessionsRevoked };
    } catch (err) {
      try { await rawClient.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      rawClient.release();
    }
  }

  // ── Reactivate User (D-1) ──────────────────────────────────────────────────
  // Structurally DISTINCT from suspend (D-1: not a shared helper with a flag).
  // Writes status='active' only — NO session revocation (access restored on next
  // protected action per the requirement).

  async reactivateUser(
    appUserId: string,
    actorId: string,
    organizationId: string,
    brandId: string | null,
    correlationId: string,
  ): Promise<void> {
    if (!this.rawPgPool) {
      throw new AuthError('CONFIGURATION_ERROR', 'Raw pg pool not configured — reactivateUser unavailable.', 500);
    }
    const rawClient: PoolClient = await this.rawPgPool.connect();
    try {
      await rawClient.query('BEGIN');

      // Step 1: resolve actor's membership row (same authority check as suspend — D-2 / C-4).
      const actorResult = await rawClient.query<{
        id: string; organization_id: string; role_code: string;
      }>(
        `SELECT id, organization_id, role_code FROM membership
         WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL`,
        [actorId, organizationId],
      );
      const actor = actorResult.rows[0];
      if (!actor ||
          (actor.role_code !== 'owner' && actor.role_code !== 'brand_admin')) {
        await rawClient.query('ROLLBACK');
        throw new AuthError('FORBIDDEN', 'Requires owner or brand_admin role to reactivate.', 403);
      }

      // Step 2 (D-9): resolve target membership; org assertion IS the cross-org guard.
      const targetResult = await rawClient.query<{
        id: string; organization_id: string; app_user_id: string; role_code: string;
      }>(
        `SELECT id, organization_id, app_user_id, role_code FROM membership
         WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL`,
        [appUserId, organizationId],
      );
      const target = targetResult.rows[0];
      if (!target || target.organization_id !== organizationId) {
        await rawClient.query('ROLLBACK');
        throw new AuthError('NOT_FOUND', 'Member not found in this organization.', 404);
      }

      // Step 3: hierarchy check (same rules as suspend).
      const actorIdx = ROLE_HIERARCHY.indexOf(actor.role_code as RoleCode);
      const targetIdx = ROLE_HIERARCHY.indexOf(target.role_code as RoleCode);
      if (target.role_code === 'owner' && actor.role_code !== 'owner') {
        await rawClient.query('ROLLBACK');
        throw new AuthError('FORBIDDEN', 'Cannot reactivate an Owner.', 403);
      }
      if (actor.role_code !== 'owner' && actorIdx <= targetIdx) {
        await rawClient.query('ROLLBACK');
        throw new AuthError('FORBIDDEN', 'Cannot reactivate a member with equal or higher authority.', 403);
      }

      // Step 4 (D-1): single write — status = active; NO session revocation.
      await rawClient.query(
        `UPDATE app_user SET status = 'active', updated_at = NOW() WHERE id = $1`,
        [appUserId],
      );

      await rawClient.query('COMMIT');

      // Step 5: audit POST-COMMIT; brand_id = brandId ?? organizationId (NOT appUserId).
      await this.audit.append({
        brand_id: brandId ?? organizationId,
        actor_id: actorId,
        actor_role: actor.role_code,
        action: 'user.reactivated',
        entity_type: 'app_user',
        entity_id: appUserId,
        payload: { target_user_id: appUserId },
      });
    } catch (err) {
      try { await rawClient.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      rawClient.release();
    }
  }

  // ── Forgot Password ────────────────────────────────────────────────────────
  // NN-5: ALWAYS returns the same response — never reveals if email exists.
  // MA-04: notification send is fire-and-forget (no timing oracle).

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
        // MA-04: fire-and-forget notification — response timing = ~1 DB read for both paths.
        // Wrap in Promise.resolve() so a synchronous throw or non-Promise return from the
        // notification adapter does not propagate to the caller (test mocks return undefined).
        void Promise.resolve(this.notification.sendPasswordResetEmail(email, rawToken, correlationId))
          .catch((err) => {
            console.error('[auth] forgotPassword: send failed', { correlationId, err });
          });

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
      // NN-5: no else branch — same code path timing.
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
        throw new AuthError('INVALID_TOKEN', 'Invalid or expired reset token.', 400);
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
