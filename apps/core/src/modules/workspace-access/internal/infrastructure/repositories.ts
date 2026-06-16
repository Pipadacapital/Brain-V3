/**
 * workspace-access infrastructure — Postgres repository implementations.
 *
 * All queries use the 3-GUC QueryContext (NN-1).
 * app_user reads use explicit WHERE id = $userId (no RLS — service-layer isolation).
 * All other tables use RLS via the appropriate GUC.
 */

import type { DbClient, QueryContext } from '@brain/db';
import type { AppUser, UserSession, PasswordResetToken, EmailVerificationToken } from '../domain/auth/entities.js';
import type { Organization, OnboardingStatus } from '../domain/organization/entities.js';
import type { Brand, CurrencyCode, BrandTimezone, RevenueDefinition } from '../domain/brand/entities.js';
import type { Membership, RoleCode } from '../domain/membership/entities.js';
import type { Invite, InviteStatus } from '../domain/invite/entities.js';

// ── Cursor pagination helper ──────────────────────────────────────────────────

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf-8');
}

// ── App User Repository ───────────────────────────────────────────────────────
// NO RLS on app_user — service-layer isolation via explicit WHERE clauses.

export class AppUserRepository {
  constructor(private readonly db: DbClient) {}

  /** Find by email (case-insensitive via citext). Service-layer isolation: no GUC needed. */
  async findByEmail(
    email: string,
    ctx: QueryContext,
  ): Promise<AppUser | null> {
    const result = await this.db.query<{
      id: string; email: string; email_normalized: string;
      password_hash: string; email_verified_at: Date | null;
      status: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, email, email_normalized, password_hash, email_verified_at, status, created_at, updated_at
       FROM app_user
       WHERE email = $1`,
      [email],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /** Find by id. Service-layer isolation: explicit WHERE id = $1. */
  async findById(id: string, ctx: QueryContext): Promise<AppUser | null> {
    const result = await this.db.query<{
      id: string; email: string; email_normalized: string;
      password_hash: string; email_verified_at: Date | null;
      status: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, email, email_normalized, password_hash, email_verified_at, status, created_at, updated_at
       FROM app_user
       WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async insert(
    data: { email: string; emailNormalized: string; passwordHash: string },
    ctx: QueryContext,
  ): Promise<AppUser> {
    const result = await this.db.query<{
      id: string; email: string; email_normalized: string;
      password_hash: string; email_verified_at: Date | null;
      status: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `INSERT INTO app_user (email, email_normalized, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, email_normalized, password_hash, email_verified_at, status, created_at, updated_at`,
      [data.email, data.emailNormalized, data.passwordHash],
    );
    return this.mapRow(result.rows[0]!);
  }

  async markEmailVerified(id: string, verifiedAt: Date, ctx: QueryContext): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE app_user SET email_verified_at = $1, updated_at = NOW() WHERE id = $2`,
      [verifiedAt, id],
    );
  }

  async updatePasswordHash(id: string, passwordHash: string, ctx: QueryContext): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE app_user SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [passwordHash, id],
    );
  }

  async updateStatus(id: string, status: 'active' | 'suspended', ctx: QueryContext): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE app_user SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, id],
    );
  }

  /** Find pending invite for a given email (used by register flow AC-7). */
  async findPendingInviteByEmail(email: string, ctx: QueryContext): Promise<{ id: string } | null> {
    const result = await this.db.query<{ id: string }>(
      ctx,
      `SELECT id FROM invite WHERE email = $1 AND status = 'pending' AND expires_at > NOW() LIMIT 1`,
      [email.toLowerCase()],
    );
    return result.rows[0] ?? null;
  }

  private mapRow(row: {
    id: string; email: string; email_normalized: string;
    password_hash: string; email_verified_at: Date | null;
    status: string; created_at: Date; updated_at: Date;
  }): AppUser {
    return {
      id: row.id,
      email: row.email,
      emailNormalized: row.email_normalized,
      passwordHash: row.password_hash,
      emailVerifiedAt: row.email_verified_at,
      status: row.status as 'active' | 'suspended',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ── User Session Repository ───────────────────────────────────────────────────
// RLS: app.current_user_id — set via ctx.userId.

export class UserSessionRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    data: {
      appUserId: string;
      jti: string;
      refreshTokenHash: string;
      expiresAt: Date;
      ip?: string | null;
      userAgent?: string | null;
      familyId?: string | null;
      rotatedFrom?: string | null;
    },
    ctx: QueryContext,
  ): Promise<UserSession> {
    const result = await this.db.query<{
      id: string; app_user_id: string; jti: string;
      refresh_token_hash: string; issued_at: Date; expires_at: Date;
      revoked_at: Date | null; ip: string | null; user_agent: string | null; created_at: Date;
      family_id: string | null; rotated_from: string | null; used_at: Date | null;
    }>(
      ctx,
      `INSERT INTO user_session (app_user_id, jti, refresh_token_hash, expires_at, ip, user_agent, family_id, rotated_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, app_user_id, jti, refresh_token_hash, issued_at, expires_at, revoked_at, ip, user_agent, created_at, family_id, rotated_from, used_at`,
      [
        data.appUserId, data.jti, data.refreshTokenHash, data.expiresAt,
        data.ip ?? null, data.userAgent ?? null,
        data.familyId ?? null, data.rotatedFrom ?? null,
      ],
    );
    return this.mapRow(result.rows[0]!);
  }

  /** Update family_id to = id (used after root insert to set family_id = own id). */
  async setFamilyIdToSelf(id: string, ctx: QueryContext): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE user_session SET family_id = id WHERE id = $1`,
      [id],
    );
  }

  /** Find an active (non-revoked, non-expired) session by jti (NN-3 revocation check). */
  async findActiveByJti(jti: string, ctx: QueryContext): Promise<UserSession | null> {
    const result = await this.db.query<{
      id: string; app_user_id: string; jti: string;
      refresh_token_hash: string; issued_at: Date; expires_at: Date;
      revoked_at: Date | null; ip: string | null; user_agent: string | null; created_at: Date;
      family_id: string | null; rotated_from: string | null; used_at: Date | null;
    }>(
      ctx,
      `SELECT id, app_user_id, jti, refresh_token_hash, issued_at, expires_at, revoked_at, ip, user_agent, created_at, family_id, rotated_from, used_at
       FROM user_session
       WHERE jti = $1
         AND revoked_at IS NULL
         AND expires_at > NOW()`,
      [jti],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Find a session row by refresh_token_hash using a raw client (no user GUC — token IS the credential).
   * Uses SELECT FOR UPDATE to serialize concurrent rotation attempts (MA-03).
   * Returns the raw row so the caller can check revoked_at / used_at before proceeding.
   */
  async findForUpdateByRefreshHash(
    refreshTokenHash: string,
    rawClient: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  ): Promise<{
    id: string; app_user_id: string; jti: string;
    refresh_token_hash: string; issued_at: Date; expires_at: Date;
    revoked_at: Date | null; used_at: Date | null;
    family_id: string | null; rotated_from: string | null;
  } | null> {
    const result = await rawClient.query(
      `SELECT id, app_user_id, jti, refresh_token_hash, issued_at, expires_at, revoked_at, used_at, family_id, rotated_from
       FROM user_session
       WHERE refresh_token_hash = $1
       FOR UPDATE`,
      [refreshTokenHash],
    );
    const row = (result.rows[0] as {
      id: string; app_user_id: string; jti: string;
      refresh_token_hash: string; issued_at: Date; expires_at: Date;
      revoked_at: Date | null; used_at: Date | null;
      family_id: string | null; rotated_from: string | null;
    } | undefined) ?? null;
    return row;
  }

  /** Revoke a session by setting revoked_at (NN-3 logout). */
  async revoke(jti: string, ctx: QueryContext): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE user_session SET revoked_at = NOW() WHERE jti = $1`,
      [jti],
    );
  }

  /**
   * Mark a session row as rotated: set revoked_at + used_at = NOW() (AC-1 rotation step).
   * Must be called inside an existing transaction on the same raw client.
   */
  async markRotatedRaw(
    id: string,
    rawClient: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  ): Promise<void> {
    await rawClient.query(
      `UPDATE user_session SET revoked_at = NOW(), used_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  /**
   * Family-wipe: revoke ALL active sessions in the given family (replay detection — AC-1).
   * Must be called inside an existing transaction on the same raw client.
   * NN-1: The query is scoped to family_id — under the user's RLS GUC (set in the txn via
   * SET LOCAL app.current_user_id), sessions of OTHER users are invisible even if somehow
   * the family_id were guessed.
   */
  async revokeFamilyRaw(
    familyId: string,
    rawClient: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  ): Promise<number> {
    const result = await rawClient.query(
      `UPDATE user_session SET revoked_at = NOW()
       WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Revoke all active sessions for a user (AC-2 suspend + scope=all logout path).
   * Returns the count of revoked sessions.
   */
  async revokeAllForUser(appUserId: string, ctx: QueryContext): Promise<number> {
    const result = await this.db.query<{ rowcount: string }>(
      ctx,
      `WITH revoked AS (
         UPDATE user_session SET revoked_at = NOW()
         WHERE app_user_id = $1 AND revoked_at IS NULL
         RETURNING id
       )
       SELECT COUNT(*)::text AS rowcount FROM revoked`,
      [appUserId],
    );
    return parseInt(result.rows[0]?.rowcount ?? '0', 10);
  }

  /**
   * Revoke all active sessions for a user (brand-scoped variant, AC-2).
   * M1: sessions are user-global; brandId param reserved for post-M1 per-brand sessions.
   * Currently revokes all user sessions regardless of brandId (same UPDATE).
   */
  async revokeAllForUserAndBrand(
    appUserId: string,
    _brandId: string | null,
    ctx: QueryContext,
    // Accept optional raw client so the caller can join their transaction
    rawClient?: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  ): Promise<number> {
    // M1: sessions are user-global; brandId param reserved for post-M1 per-brand sessions.
    // Currently revokes all user sessions regardless of brandId.
    if (rawClient) {
      const result = await rawClient.query(
        `UPDATE user_session SET revoked_at = NOW()
         WHERE app_user_id = $1 AND revoked_at IS NULL`,
        [appUserId],
      );
      return result.rowCount ?? 0;
    }
    return this.revokeAllForUser(appUserId, ctx);
  }

  private mapRow(row: {
    id: string; app_user_id: string; jti: string;
    refresh_token_hash: string; issued_at: Date; expires_at: Date;
    revoked_at: Date | null; ip: string | null; user_agent: string | null; created_at: Date;
    family_id?: string | null; rotated_from?: string | null; used_at?: Date | null;
  }): UserSession {
    return {
      id: row.id,
      appUserId: row.app_user_id,
      jti: row.jti,
      refreshTokenHash: row.refresh_token_hash,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      ip: row.ip,
      userAgent: row.user_agent,
      createdAt: row.created_at,
      familyId: row.family_id ?? null,
      rotatedFrom: row.rotated_from ?? null,
      usedAt: row.used_at ?? null,
    };
  }
}

// ── Password Reset Repository ─────────────────────────────────────────────────
// RLS: app.current_user_id.

export class PasswordResetRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    data: { appUserId: string; tokenHash: string; expiresAt: Date },
    ctx: QueryContext,
  ): Promise<PasswordResetToken> {
    const result = await this.db.query<{
      id: string; app_user_id: string; token_hash: string;
      expires_at: Date; used_at: Date | null; created_at: Date;
    }>(
      ctx,
      `INSERT INTO password_reset (app_user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, app_user_id, token_hash, expires_at, used_at, created_at`,
      [data.appUserId, data.tokenHash, data.expiresAt],
    );
    return this.mapRow(result.rows[0]!);
  }

  /** Find an unused, non-expired token by its hash (timing-safe: hash compared in DB). */
  async findValidByHash(tokenHash: string, ctx: QueryContext): Promise<PasswordResetToken | null> {
    const result = await this.db.query<{
      id: string; app_user_id: string; token_hash: string;
      expires_at: Date; used_at: Date | null; created_at: Date;
    }>(
      ctx,
      `SELECT id, app_user_id, token_hash, expires_at, used_at, created_at
       FROM password_reset
       WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > NOW()`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async markUsed(id: string, ctx: QueryContext): Promise<void> {
    await this.db.query(ctx, `UPDATE password_reset SET used_at = NOW() WHERE id = $1`, [id]);
  }

  private mapRow(row: {
    id: string; app_user_id: string; token_hash: string;
    expires_at: Date; used_at: Date | null; created_at: Date;
  }): PasswordResetToken {
    return {
      id: row.id,
      appUserId: row.app_user_id,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      createdAt: row.created_at,
    };
  }
}

// ── Email Verification Repository ─────────────────────────────────────────────
// RLS: app.current_user_id.

export class EmailVerificationRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    data: { appUserId: string; tokenHash: string; expiresAt: Date },
    ctx: QueryContext,
  ): Promise<EmailVerificationToken> {
    const result = await this.db.query<{
      id: string; app_user_id: string; token_hash: string;
      expires_at: Date; used_at: Date | null; created_at: Date;
    }>(
      ctx,
      `INSERT INTO email_verification (app_user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, app_user_id, token_hash, expires_at, used_at, created_at`,
      [data.appUserId, data.tokenHash, data.expiresAt],
    );
    return this.mapRow(result.rows[0]!);
  }

  async findValidByHash(tokenHash: string, ctx: QueryContext): Promise<EmailVerificationToken | null> {
    const result = await this.db.query<{
      id: string; app_user_id: string; token_hash: string;
      expires_at: Date; used_at: Date | null; created_at: Date;
    }>(
      ctx,
      `SELECT id, app_user_id, token_hash, expires_at, used_at, created_at
       FROM email_verification
       WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > NOW()`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async markUsed(id: string, ctx: QueryContext): Promise<void> {
    await this.db.query(ctx, `UPDATE email_verification SET used_at = NOW() WHERE id = $1`, [id]);
  }

  private mapRow(row: {
    id: string; app_user_id: string; token_hash: string;
    expires_at: Date; used_at: Date | null; created_at: Date;
  }): EmailVerificationToken {
    return {
      id: row.id,
      appUserId: row.app_user_id,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      createdAt: row.created_at,
    };
  }
}

// ── Organization Repository ───────────────────────────────────────────────────
// RLS: app.current_workspace_id — set via ctx.workspaceId.

export class OrganizationRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    data: { name: string; slug: string; ownerUserId: string; regionCode?: string },
    ctx: QueryContext,
  ): Promise<Organization> {
    const result = await this.db.query<{
      id: string; name: string; slug: string;
      owner_user_id: string; region_code: string;
      onboarding_status: string; onboarding_step: number;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `INSERT INTO organization (name, slug, owner_user_id, region_code)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, slug, owner_user_id, region_code, onboarding_status, onboarding_step, created_at, updated_at`,
      [data.name, data.slug, data.ownerUserId, data.regionCode ?? 'IN'],
    );
    return this.mapRow(result.rows[0]!);
  }

  async findById(id: string, ctx: QueryContext): Promise<Organization | null> {
    const result = await this.db.query<{
      id: string; name: string; slug: string;
      owner_user_id: string; region_code: string;
      onboarding_status: string; onboarding_step: number;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, name, slug, owner_user_id, region_code, onboarding_status, onboarding_step, created_at, updated_at
       FROM organization WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async findBySlug(slug: string, ctx: QueryContext): Promise<Organization | null> {
    const result = await this.db.query<{
      id: string; name: string; slug: string;
      owner_user_id: string; region_code: string;
      onboarding_status: string; onboarding_step: number;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, name, slug, owner_user_id, region_code, onboarding_status, onboarding_step, created_at, updated_at
       FROM organization WHERE slug = $1`,
      [slug],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /** List all workspaces a user is a member of (cross-workspace, no RLS needed for membership lookup). */
  async findByUserId(userId: string, ctx: QueryContext): Promise<Organization[]> {
    const result = await this.db.query<{
      id: string; name: string; slug: string;
      owner_user_id: string; region_code: string;
      onboarding_status: string; onboarding_step: number;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT o.id, o.name, o.slug, o.owner_user_id, o.region_code, o.onboarding_status, o.onboarding_step, o.created_at, o.updated_at
       FROM organization o
       INNER JOIN membership m ON m.organization_id = o.id
       WHERE m.app_user_id = $1 AND m.brand_id IS NULL
       ORDER BY o.created_at DESC`,
      [userId],
    );
    return result.rows.map((r) => this.mapRow(r));
  }

  async update(
    id: string,
    data: { name?: string },
    ctx: QueryContext,
  ): Promise<Organization | null> {
    const result = await this.db.query<{
      id: string; name: string; slug: string;
      owner_user_id: string; region_code: string;
      onboarding_status: string; onboarding_step: number;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `UPDATE organization SET name = COALESCE($1, name), updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, slug, owner_user_id, region_code, onboarding_status, onboarding_step, created_at, updated_at`,
      [data.name ?? null, id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Advance onboarding_status + onboarding_step forward-only (idempotent guard).
   * Only advances if the current step is less than the target step.
   * MA-09: M1 tracks first-brand onboarding only.
   */
  async advanceOnboardingStatus(
    orgId: string,
    newStatus: OnboardingStatus,
    newStep: number,
    ctx: QueryContext,
  ): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE organization
       SET onboarding_status = $1, onboarding_step = $2, updated_at = NOW()
       WHERE id = $3 AND onboarding_step < $2`,
      [newStatus, newStep, orgId],
    );
  }

  private mapRow(row: {
    id: string; name: string; slug: string;
    owner_user_id: string; region_code: string;
    onboarding_status?: string; onboarding_step?: number;
    created_at: Date; updated_at: Date;
  }): Organization {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      ownerUserId: row.owner_user_id,
      regionCode: row.region_code,
      // MA-08: column-absent defensive fallback (deploy order: migrate → core → web)
      onboardingStatus: (row.onboarding_status ?? 'pending') as OnboardingStatus,
      onboardingStep: row.onboarding_step ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ── Brand Repository ──────────────────────────────────────────────────────────
// RLS: app.current_brand_id — set via ctx.brandId.

export class BrandRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    data: {
      organizationId: string;
      displayName: string;
      domain?: string | null;
      regionCode?: string;
      currencyCode?: CurrencyCode;
      timezone?: BrandTimezone;
      revenueDefinition?: RevenueDefinition;
    },
    ctx: QueryContext,
  ): Promise<Brand> {
    const result = await this.db.query<{
      id: string; organization_id: string; display_name: string;
      domain: string | null; status: string; region_code: string;
      currency_code: string | null; timezone: string | null; revenue_definition: string | null;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `INSERT INTO brand (organization_id, display_name, domain, region_code, currency_code, timezone, revenue_definition)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, organization_id, display_name, domain, status, region_code, currency_code, timezone, revenue_definition, created_at, updated_at`,
      [
        data.organizationId, data.displayName, data.domain ?? null,
        data.regionCode ?? 'IN',
        data.currencyCode ?? 'INR',
        data.timezone ?? 'Asia/Kolkata',
        data.revenueDefinition ?? 'realized',
      ],
    );
    return this.mapRow(result.rows[0]!);
  }

  async findById(id: string, ctx: QueryContext): Promise<Brand | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; display_name: string;
      domain: string | null; status: string; region_code: string;
      currency_code: string | null; timezone: string | null; revenue_definition: string | null;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, organization_id, display_name, domain, status, region_code, currency_code, timezone, revenue_definition, created_at, updated_at
       FROM brand WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByOrganizationId(
    organizationId: string,
    cursor: string | undefined,
    limit: number,
    ctx: QueryContext,
  ): Promise<{ items: Brand[]; nextCursor: string | null; hasMore: boolean }> {
    const cursorId = cursor ? decodeCursor(cursor) : null;

    const result = await this.db.query<{
      id: string; organization_id: string; display_name: string;
      domain: string | null; status: string; region_code: string;
      currency_code: string | null; timezone: string | null; revenue_definition: string | null;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, organization_id, display_name, domain, status, region_code, currency_code, timezone, revenue_definition, created_at, updated_at
       FROM brand
       WHERE organization_id = $1
         ${cursorId ? 'AND id > $3' : ''}
       ORDER BY id ASC
       LIMIT $2`,
      cursorId ? [organizationId, limit + 1, cursorId] : [organizationId, limit + 1],
    );

    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map((r) => this.mapRow(r));
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem ? encodeCursor(lastItem.id) : null;

    return { items, nextCursor, hasMore };
  }

  async update(
    id: string,
    data: {
      displayName?: string;
      domain?: string | null;
      status?: 'active' | 'archived';
      currencyCode?: CurrencyCode;
      timezone?: BrandTimezone;
      revenueDefinition?: RevenueDefinition;
    },
    ctx: QueryContext,
  ): Promise<Brand | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; display_name: string;
      domain: string | null; status: string; region_code: string;
      currency_code: string | null; timezone: string | null; revenue_definition: string | null;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `UPDATE brand SET
         display_name = COALESCE($1, display_name),
         domain = CASE WHEN $2::boolean THEN $3 ELSE domain END,
         status = COALESCE($4, status),
         currency_code = COALESCE($5, currency_code),
         timezone = COALESCE($6, timezone),
         revenue_definition = COALESCE($7, revenue_definition),
         updated_at = NOW()
       WHERE id = $8
       RETURNING id, organization_id, display_name, domain, status, region_code, currency_code, timezone, revenue_definition, created_at, updated_at`,
      [
        data.displayName ?? null,
        'domain' in data ? true : false,
        data.domain ?? null,
        data.status ?? null,
        data.currencyCode ?? null,
        data.timezone ?? null,
        data.revenueDefinition ?? null,
        id,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  private mapRow(row: {
    id: string; organization_id: string; display_name: string;
    domain: string | null; status: string; region_code: string;
    currency_code?: string | null; timezone?: string | null; revenue_definition?: string | null;
    created_at: Date; updated_at: Date;
  }): Brand {
    return {
      id: row.id,
      organizationId: row.organization_id,
      displayName: row.display_name,
      domain: row.domain,
      status: row.status as 'active' | 'archived',
      regionCode: row.region_code,
      // MA-08: column-absent defensive ?? fallback for deploy-window race (migrate → core → web).
      currencyCode: (row.currency_code ?? 'INR') as CurrencyCode,
      timezone: (row.timezone ?? 'Asia/Kolkata') as BrandTimezone,
      revenueDefinition: (row.revenue_definition ?? 'realized') as RevenueDefinition,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ── Membership Repository ─────────────────────────────────────────────────────
// RLS: app.current_workspace_id.

export class MembershipRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    data: {
      organizationId: string;
      brandId: string | null;
      appUserId: string;
      roleCode: RoleCode;
    },
    ctx: QueryContext,
  ): Promise<Membership> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
       VALUES ($1, $2, $3, $4)
       RETURNING id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at`,
      [data.organizationId, data.brandId, data.appUserId, data.roleCode],
    );
    return this.mapRow(result.rows[0]!);
  }

  async findByUserAndOrg(
    appUserId: string,
    organizationId: string,
    brandId: string | null,
    ctx: QueryContext,
  ): Promise<Membership | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      brandId
        ? `SELECT id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at
           FROM membership
           WHERE app_user_id = $1 AND organization_id = $2 AND brand_id = $3`
        : `SELECT id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at
           FROM membership
           WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL`,
      brandId ? [appUserId, organizationId, brandId] : [appUserId, organizationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async listByOrganization(
    organizationId: string,
    brandId: string | undefined,
    cursor: string | undefined,
    limit: number,
    ctx: QueryContext,
  ): Promise<{ items: Array<Membership & { email: string; user_email: string; user_full_name: string; user_status: 'active' | 'suspended' }>; nextCursor: string | null; hasMore: boolean }> {
    const cursorId = cursor ? decodeCursor(cursor) : null;

    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; email: string; status: string;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT m.id, m.organization_id, m.brand_id, m.app_user_id, m.role_code,
              u.email, u.status, m.created_at, m.updated_at
       FROM membership m
       INNER JOIN app_user u ON u.id = m.app_user_id
       WHERE m.organization_id = $1
         ${brandId ? 'AND m.brand_id = $3' : 'AND m.brand_id IS NULL'}
         ${cursorId ? `AND m.id > ${brandId ? '$4' : '$3'}` : ''}
       ORDER BY m.id ASC
       LIMIT $2`,
      [
        organizationId,
        limit + 1,
        ...(brandId ? [brandId] : []),
        ...(cursorId ? [cursorId] : []),
      ],
    );

    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map((r) => ({
      ...this.mapRow(r),
      email: r.email,
      // Slice 3 / field-mismatch fix: user_email + user_full_name + user_status
      // for the members-table.tsx (reads user_email / user_full_name / user_status).
      // app_user has no separate name column → use email as placeholder (plan §3).
      user_email: r.email,
      user_full_name: r.email,
      user_status: (r.status as 'active' | 'suspended'),
    }));
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem ? encodeCursor(lastItem.id) : null;
    return { items, nextCursor, hasMore };
  }

  async countOwners(organizationId: string, ctx: QueryContext): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      ctx,
      `SELECT COUNT(*) AS count FROM membership
       WHERE organization_id = $1 AND role_code = 'owner' AND brand_id IS NULL`,
      [organizationId],
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  async updateRole(id: string, roleCode: RoleCode, ctx: QueryContext): Promise<Membership | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `UPDATE membership SET role_code = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at`,
      [roleCode, id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async delete(id: string, ctx: QueryContext): Promise<void> {
    await this.db.query(ctx, `DELETE FROM membership WHERE id = $1`, [id]);
  }

  async findById(id: string, ctx: QueryContext): Promise<Membership | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at
       FROM membership WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Resolve the user's "active" membership for session bootstrapping after login.
   * Reads the user's OWN membership rows via the membership_self_read RLS policy
   * (requires ctx.userId → app.current_user_id GUC; no workspace GUC needed).
   * Prefers a brand-level membership (brand_id NOT NULL) over an org-level one,
   * most recent first — so a fully-onboarded user resolves to {brand, role}.
   */
  async findActiveByUser(appUserId: string, ctx: QueryContext): Promise<Membership | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at
       FROM membership
       WHERE app_user_id = $1
       ORDER BY (brand_id IS NOT NULL) DESC, created_at DESC
       LIMIT 1`,
      [appUserId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  private mapRow(row: {
    id: string; organization_id: string; brand_id: string | null;
    app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
  }): Membership {
    return {
      id: row.id,
      organizationId: row.organization_id,
      brandId: row.brand_id,
      appUserId: row.app_user_id,
      roleCode: row.role_code as RoleCode,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ── Invite Repository ─────────────────────────────────────────────────────────
// RLS: compound NN-7 (two PERMISSIVE policies for nullable brand_id).
// GUC: ctx.workspaceId (for org-level) + ctx.brandId (for brand-level).

export class InviteRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    data: {
      organizationId: string;
      brandId: string | null;
      email: string;
      roleCode: RoleCode;
      tokenHash: string;
      invitedByUserId: string;
      expiresAt: Date;
    },
    ctx: QueryContext,
  ): Promise<Invite> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      email: string; role_code: string; token_hash: string;
      invited_by_user_id: string; status: string;
      expires_at: Date; accepted_at: Date | null; created_at: Date;
    }>(
      ctx,
      `INSERT INTO invite (organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, status, expires_at, accepted_at, created_at`,
      [
        data.organizationId, data.brandId, data.email, data.roleCode,
        data.tokenHash, data.invitedByUserId, data.expiresAt,
      ],
    );
    return this.mapRow(result.rows[0]!);
  }

  /** Find a valid (pending, non-expired) invite by token hash. */
  async findValidByHash(tokenHash: string, ctx: QueryContext): Promise<Invite | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      email: string; role_code: string; token_hash: string;
      invited_by_user_id: string; status: string;
      expires_at: Date; accepted_at: Date | null; created_at: Date;
    }>(
      ctx,
      `SELECT id, organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, status, expires_at, accepted_at, created_at
       FROM invite
       WHERE token_hash = $1
         AND status = 'pending'
         AND expires_at > NOW()`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async markAccepted(id: string, ctx: QueryContext): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE invite SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  async updateStatus(id: string, status: InviteStatus, ctx: QueryContext): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE invite SET status = $1 WHERE id = $2`,
      [status, id],
    );
  }

  /**
   * D-3: Rotate token on resend — update token_hash + expires_at on the existing pending row.
   * No second row created. Uses GUC pool (RLS-enforced by caller's ctx).
   */
  async rotateToken(
    id: string,
    tokenHash: string,
    expiresAt: Date,
    ctx: QueryContext,
  ): Promise<Invite | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      email: string; role_code: string; token_hash: string;
      invited_by_user_id: string; status: string;
      expires_at: Date; accepted_at: Date | null; created_at: Date;
    }>(
      ctx,
      `UPDATE invite SET token_hash = $1, expires_at = $2
       WHERE id = $3 AND status = 'pending'
       RETURNING id, organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, status, expires_at, accepted_at, created_at`,
      [tokenHash, expiresAt, id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * D-4: List pending invites with actor-role-based predicate.
   * - owner: all pending in org (RLS scopes to org; no extra predicate).
   * - brand_admin: all pending in brand scope (RLS GUCs handle it).
   * - manager/analyst: only invites they created (AND invited_by_user_id = $actor).
   * RLS provides isolation underneath (workspaceId + brandId GUCs via ctx).
   *
   * Uses fully-parameterized queries; no string interpolation of user-supplied values.
   */
  async listPending(
    organizationId: string,
    brandId: string | null,
    actorRole: string,
    actorUserId: string,
    cursor: string | undefined,
    limit: number,
    ctx: QueryContext,
  ): Promise<{ items: Invite[]; nextCursor: string | null; hasMore: boolean }> {
    const cursorId = cursor ? decodeCursor(cursor) : null;

    // Build params array dynamically to keep all user-data fully parameterized.
    // $1 = organizationId, $2 = limit + 1, then optional $3+ for brandId/actorUserId/cursorId.
    const params: unknown[] = [organizationId, limit + 1];
    let paramIdx = 3;

    // D-4: Owner sees ALL pending invites in the org (both org-level brand_id=NULL and
    // brand-level invites). brandId filter is applied for brand_admin (brand-scoped) and
    // is removed entirely for owner so org-level invites (brand_id=NULL) are visible even
    // when the owner's session carries a non-null brandId context.
    let brandClause: string;
    if (actorRole === 'owner') {
      // Owner: no brand filter — returns all pending invites for the org.
      brandClause = '';
    } else if (brandId) {
      brandClause = `AND i.brand_id = $${paramIdx++}`;
      params.push(brandId);
    } else {
      brandClause = `AND i.brand_id IS NULL`;
    }

    let actorClause = '';
    if (actorRole === 'manager' || actorRole === 'analyst') {
      actorClause = `AND i.invited_by_user_id = $${paramIdx++}`;
      params.push(actorUserId);
    }

    let cursorClause = '';
    if (cursorId) {
      cursorClause = `AND i.id > $${paramIdx++}`;
      params.push(cursorId);
    }

    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      email: string; role_code: string; token_hash: string;
      invited_by_user_id: string; status: string;
      expires_at: Date; accepted_at: Date | null; created_at: Date;
    }>(
      ctx,
      `SELECT i.id, i.organization_id, i.brand_id, i.email, i.role_code, i.token_hash,
              i.invited_by_user_id, i.status, i.expires_at, i.accepted_at, i.created_at
       FROM invite i
       WHERE i.organization_id = $1
         AND i.status = 'pending'
         AND i.expires_at > NOW()
         ${brandClause}
         ${actorClause}
         ${cursorClause}
       ORDER BY i.id ASC
       LIMIT $2`,
      params,
    );

    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map((r) => this.mapRow(r));
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem ? encodeCursor(lastItem.id) : null;
    return { items, nextCursor, hasMore };
  }

  private mapRow(row: {
    id: string; organization_id: string; brand_id: string | null;
    email: string; role_code: string; token_hash: string;
    invited_by_user_id: string; status: string;
    expires_at: Date; accepted_at: Date | null; created_at: Date;
  }): Invite {
    return {
      id: row.id,
      organizationId: row.organization_id,
      brandId: row.brand_id,
      email: row.email,
      roleCode: row.role_code as RoleCode,
      tokenHash: row.token_hash,
      invitedByUserId: row.invited_by_user_id,
      status: row.status as InviteStatus,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      createdAt: row.created_at,
    };
  }
}
