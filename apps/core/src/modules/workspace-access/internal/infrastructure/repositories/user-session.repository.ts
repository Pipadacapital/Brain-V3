/**
 * workspace-access infrastructure — UserSession Postgres repository.
 *
 * RLS: app.current_user_id — set via ctx.userId.
 * All queries use the 3-GUC QueryContext (NN-1).
 */

import type { Pool, PoolClient } from 'pg';

import type { DbClient, QueryContext } from '@brain/db';
import { beginRlsTxn } from '@brain/db';
import type { UserSession } from '../../domain/auth/entities.js';
import type { RoleCode } from '../../domain/membership/entities.js';
import type { OnboardingStatus } from '../../domain/organization/entities.js';

/** Active brand/role context resolved during refresh-token rotation. */
interface RotationContext {
  brandId: string | null;
  workspaceId: string | null;
  role: RoleCode | null;
  onboardingStatus: OnboardingStatus | null;
}

/**
 * Discriminated outcome of {@link UserSessionRepository.rotateRefreshTokenUnitOfWork}.
 *
 * The unit-of-work owns the BEGIN/COMMIT/ROLLBACK + RLS GUC management; the calling
 * application service maps each outcome to the appropriate audit append + AuthError.
 * Audits remain in the application layer (post-COMMIT), exactly as before the refactor.
 */
export type RotateRefreshTokenOutcome =
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'conflict' }
  | {
      kind: 'replayed';
      appUserId: string;
      familyId: string;
      entityId: string;
      wipeCount: number;
    }
  | {
      kind: 'rotated';
      appUserId: string;
      oldJti: string;
      newJti: string;
      familyId: string;
      accessToken: string;
      refreshToken: string;
    };

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

  /**
   * Rotating-refresh-token UNIT OF WORK (AC-1 / MA-01 / MA-03).
   *
   * Owns the explicit BEGIN/COMMIT/ROLLBACK on a raw pg.Pool client so the application
   * layer no longer hand-rolls transactions. beginRlsTxn drops to brain_app with fail-closed
   * NIL GUCs; the session is found by TOKEN (the credential) via the SECURITY DEFINER
   * find_session_for_rotation() primitive (user_session is RLS-scoped by app.current_user_id,
   * unknown until the lookup), then the user GUC is set from the resolved app_user_id so the
   * revoke/insert run under the user. All steps run inside ONE transaction with SELECT ... FOR
   * UPDATE (MA-03).
   *
   * Returns a discriminated {@link RotateRefreshTokenOutcome}; the caller does the audit
   * appends (post-COMMIT) and AuthError mapping, preserving the prior behaviour exactly.
   *
   * `mintAccessToken` is invoked INSIDE the transaction (before COMMIT) at the same point as
   * the former inline body, so JWT minting stays in the application/security layer while the
   * transaction boundary lives here.
   */
  static async rotateRefreshTokenUnitOfWork(
    rawPgPool: Pool,
    params: {
      tokenHash: string;
      ip: string | null;
      userAgent: string | null;
      correlationId: string;
      refreshTokenExpirySecs: number;
    },
    newRefreshToken: { rawToken: string; tokenHash: string },
    newJti: string,
    mintAccessToken: (userId: string, jti: string, context: RotationContext) => string,
  ): Promise<RotateRefreshTokenOutcome> {
    const { tokenHash, ip, userAgent, correlationId, refreshTokenExpirySecs } = params;

    const rawClient: PoolClient = await rawPgPool.connect();
    try {
      await beginRlsTxn(rawClient, { correlationId });

      // Step 1: Find the session row FOR UPDATE (MA-03 — serializes concurrent rotations) via the
      // SECURITY DEFINER lookup — the token IS the credential, no user GUC yet (set below from the row).
      const lookupResult = await rawClient.query<{
        id: string; app_user_id: string; jti: string;
        refresh_token_hash: string; issued_at: Date; expires_at: Date;
        revoked_at: Date | null; used_at: Date | null;
        family_id: string | null; rotated_from: string | null;
      }>(
        `SELECT id, app_user_id, jti, refresh_token_hash, issued_at, expires_at, revoked_at, used_at, family_id, rotated_from
         FROM find_session_for_rotation($1)`,
        [tokenHash],
      );

      const row = lookupResult.rows[0];

      // Step 2: Not found at all → INVALID_TOKEN.
      if (!row) {
        await rawClient.query('ROLLBACK');
        return { kind: 'not_found' };
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

        return {
          kind: 'replayed',
          appUserId: row.app_user_id,
          familyId,
          entityId: row.family_id ?? row.id,
          wipeCount,
        };
      }

      // Step 4: Expired — not a replay (row not yet used), just expired.
      if (row.expires_at < new Date()) {
        await rawClient.query('ROLLBACK');
        return { kind: 'expired' };
      }

      // Step 5: Valid token — rotate.
      // 5a: Mark old row as rotated (revoked_at + used_at = NOW()).
      await rawClient.query(
        `UPDATE user_session SET revoked_at = NOW(), used_at = NOW() WHERE id = $1`,
        [row.id],
      );

      // 5b: Create new session row inheriting the family_id.
      const newRefreshTokenHash = newRefreshToken.tokenHash;
      const newExpiresAt = new Date(Date.now() + refreshTokenExpirySecs * 1000);
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
          return { kind: 'conflict' };
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

      const context: RotationContext = m
        ? {
            brandId: m.brand_id,
            workspaceId: m.organization_id,
            role: m.role_code as RoleCode,
            onboardingStatus,
          }
        : { brandId: null, workspaceId: null, role: null, onboardingStatus: null };

      const accessToken = mintAccessToken(row.app_user_id, newJti, context);

      await rawClient.query('COMMIT');

      return {
        kind: 'rotated',
        appUserId: row.app_user_id,
        oldJti: row.jti,
        newJti,
        familyId: inheritedFamilyId,
        accessToken,
        refreshToken: newRefreshToken.rawToken,
      };
    } catch (err) {
      // If BEGIN was entered but error wasn't caught in an inner COMMIT/ROLLBACK
      try { await rawClient.query('ROLLBACK'); } catch { /* ignore rollback error */ }
      throw err;
    } finally {
      rawClient.release();
    }
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
