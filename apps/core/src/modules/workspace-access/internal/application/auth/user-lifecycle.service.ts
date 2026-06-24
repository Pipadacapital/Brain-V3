/**
 * UserLifecycleService — member suspension/reactivation + password & email lifecycle.
 *
 * Owns: suspendUser, reactivateUser, resetPassword, verifyEmail, forgotPassword.
 *
 * SECURITY INVARIANTS (preserved verbatim):
 *  - C-3: suspend writes (session-revoke + status) are atomic in ONE rawPgPool transaction.
 *  - C-4 / D-2: actor authority is resolved from the DB membership row, not the JWT.
 *  - D-1: reactivate writes status='active' only — NO session revocation.
 *  - H-1: suspend/reactivate audit uses brand_id = brandId ?? organizationId, POST-COMMIT.
 *  - NN-5: forgotPassword ALWAYS returns the same response (no enumeration); reset tokens
 *          are single-use, expiry-enforced. resetPassword re-hashes with argon2id.
 *  - MA-04: forgotPassword notification send is fire-and-forget (no timing oracle).
 *  - I-S09: no plaintext token in DB — only token_hash.
 */

import { createHash } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool, PoolClient } from 'pg';

import type { DbPool, QueryContext } from '@brain/db';
import { beginRlsTxn } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import type { NotificationService } from '../../../../notification/service.js';

import { AppUserRepository } from '../../infrastructure/repositories/app-user.repository.js';
import { PasswordResetRepository } from '../../infrastructure/repositories/password-reset.repository.js';
import { EmailVerificationRepository } from '../../infrastructure/repositories/email-verification.repository.js';
import type { RoleCode } from '../../domain/membership/entities.js';
import { ROLE_HIERARCHY } from '../../domain/membership/entities.js';
import { log } from '../../../../../log.js';

import {
  AuthError,
  ARGON2_PARAMS,
  generateToken,
  maskEmail,
  PASSWORD_RESET_EXPIRY_MS,
} from './shared.js';

export class UserLifecycleService {
  /**
   * @param pool         — GUC-middleware-wrapped pool for standard queries.
   * @param audit        — Audit writer.
   * @param notification — Notification service.
   * @param rawPgPool    — Optional raw pg.Pool (no GUC middleware) for the suspend/reactivate
   *                       paths that need explicit BEGIN/COMMIT atomicity (C-3).
   */
  constructor(
    private readonly pool: DbPool,
    private readonly audit: AuditWriter,
    private readonly notification: NotificationService,
    private readonly rawPgPool?: Pool,
  ) {}

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

  // ── Suspend User (D-8 / C-3 / C-4 / H-1) ────────────────────────────────────
  // rawPgPool BEGIN/COMMIT wrapping both writes (session-revoke + status) in ONE
  // transaction (C-3 atomicity). Actor-authority checked from DB (C-4). Audit
  // post-COMMIT with brand_id: brandId ?? organizationId (H-1 fix).

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
      // brain_app + GUCs: workspace (membership_isolation) for the actor/target membership reads,
      // and the user GUC = the SUSPENDED user (appUserId) because the session revoke below is
      // user_session_isolation-scoped (app_user_id = app.current_user_id). RLS now guards these on
      // top of the app-layer org WHERE clauses, so the app can run as a non-superuser.
      await beginRlsTxn(rawClient, { correlationId, userId: appUserId, workspaceId: organizationId, brandId: brandId ?? undefined });

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
      // brain_app + workspace GUC (membership_isolation); user GUC = the reactivated user for
      // symmetry with suspendUser (reactivate writes only app_user.status — no session revoke).
      await beginRlsTxn(rawClient, { correlationId, userId: appUserId, workspaceId: organizationId, brandId: brandId ?? undefined });

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
            log.error('forgotPassword: send failed', { err: { correlationId, err } });
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
}
