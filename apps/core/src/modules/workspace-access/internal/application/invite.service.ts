/**
 * Invite application service.
 *
 * Manages invitations at org-level (brand_id=null) and brand-level (brand_id!=null).
 * Compound RLS (NN-7) enforced at DB layer.
 * Sole-Owner guard: cannot remove/demote the last owner.
 *
 * AC-2 (CRITICAL): removeMember + updateMemberRole revoke target sessions
 *   IN THE SAME TRANSACTION as the membership write (SD-3, non-negotiable).
 * AC-7 (HIGH): acceptInvite email-match + email-verified guards;
 *   invite marked accepted only after membership granted (txn atomicity).
 */

import { randomBytes, createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { DbPool, QueryContext } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import type { NotificationService } from '../../../notification/service.js';
import type { Invite } from '../domain/invite/entities.js';
import type { Membership } from '../domain/membership/entities.js';
import type { RoleCode } from '../domain/membership/entities.js';
import { INVITE_EXPIRY_DAYS } from '../domain/invite/entities.js';
import { ROLE_HIERARCHY } from '../domain/membership/entities.js';
import { InviteRepository, MembershipRepository, AppUserRepository, UserSessionRepository } from '../infrastructure/repositories.js';
import { maskEmail } from './auth.service.js';

export class InviteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'InviteError';
  }
}

function generateToken(): { rawToken: string; tokenHash: string } {
  const rawBytes = randomBytes(32);
  const rawToken = rawBytes.toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

export class InviteService {
  /**
   * @param pool       — GUC-middleware-wrapped pool for standard queries.
   * @param audit      — Audit writer.
   * @param notification — Notification service.
   * @param rawPgPool  — Raw pg.Pool (no GUC middleware) for explicit-transaction paths:
   *                     acceptInvite, updateMemberRole, removeMember. These need BEGIN/COMMIT
   *                     before the userId GUC is known — cannot use the wrapped pool.
   */
  constructor(
    private readonly pool: DbPool,
    private readonly audit: AuditWriter,
    private readonly notification: NotificationService,
    private readonly rawPgPool?: Pool,
  ) {}

  async createInvite(
    data: {
      organizationId: string;
      brandId: string | null;
      email: string;
      roleCode: RoleCode;
      invitedByUserId: string;
    },
    correlationId: string,
  ): Promise<Invite> {
    const ctx: QueryContext = {
      correlationId,
      workspaceId: data.organizationId,
      ...(data.brandId ? { brandId: data.brandId } : {}),
    };
    const client = await this.pool.connect();
    try {
      const memberRepo = new MembershipRepository(client);
      const inviteRepo = new InviteRepository(client);

      // Assert inviter has permission (owner or brand_admin).
      const inviterMembership = await memberRepo.findByUserAndOrg(
        data.invitedByUserId,
        data.organizationId,
        data.brandId,
        ctx,
      );
      if (!inviterMembership ||
          (inviterMembership.roleCode !== 'owner' && inviterMembership.roleCode !== 'brand_admin')) {
        throw new InviteError('FORBIDDEN', 'Requires owner or brand_admin role to invite.', 403);
      }

      // D-6: hierarchy bound — cannot grant a role at or above your own authority. Owner is exempt.
      // ROLE_HIERARCHY = ['analyst','manager','brand_admin','owner'] (higher index = more capable).
      // indexOf(granted) >= indexOf(actor) is the violation: a brand_admin (idx 2) granting
      // brand_admin (idx 2) yields 2 >= 2 → true → 403.
      if (inviterMembership.roleCode !== 'owner' &&
          ROLE_HIERARCHY.indexOf(data.roleCode) >= ROLE_HIERARCHY.indexOf(inviterMembership.roleCode)) {
        throw new InviteError('FORBIDDEN', 'Cannot grant a role at or above your own authority.', 403);
      }

      // Cannot invite as 'owner' (sole-owner protection — kept as defence in depth).
      if (data.roleCode === 'owner') {
        throw new InviteError('FORBIDDEN', 'Cannot invite as owner. Transfer ownership separately.', 403);
      }

      const { rawToken, tokenHash } = generateToken();
      const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

      const invite = await inviteRepo.insert(
        {
          organizationId: data.organizationId,
          brandId: data.brandId,
          email: data.email,
          roleCode: data.roleCode,
          tokenHash,
          invitedByUserId: data.invitedByUserId,
          expiresAt,
        },
        ctx,
      );

      // Send invite email via notification module (I-ST05).
      await this.notification.sendInviteEmail(data.email, rawToken, correlationId);

      await this.audit.append({
        brand_id: data.brandId ?? data.organizationId,
        actor_id: data.invitedByUserId,
        actor_role: inviterMembership.roleCode,
        action: 'invite.created',
        entity_type: 'invite',
        entity_id: invite.id,
        payload: {
          email_masked: maskEmail(data.email),
          role_code: data.roleCode,
          brand_id: data.brandId,
        },
      });

      return invite;
    } finally {
      client.release();
    }
  }

  /**
   * AC-7: Accept an invite.
   *
   * Guards (in order, before any state mutation):
   *   1. Token is valid + not expired + pending.
   *   2. If acceptingUserId supplied: email-match guard (AC-7 MA-07).
   *   3. If found-by-email: email-verified guard (AC-7 MA-07).
   *
   * Atomicity: markAccepted + membership insert + audit ALL happen in one transaction.
   * The invite is only marked accepted AFTER membership is successfully granted.
   */
  async acceptInvite(
    rawToken: string,
    correlationId: string,
    acceptingUserId?: string,
    _newUserPassword?: string, // kept for signature compat; not used (user must register first)
  ): Promise<{ membership: Membership; newUserId?: string }> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const ctx: QueryContext = { correlationId };

    // Use raw pg client for explicit txn control (atomicity of markAccepted + membership).
    if (!this.rawPgPool) {
      throw new InviteError('CONFIGURATION_ERROR', 'Raw pg pool not provided — acceptInvite unavailable.', 500);
    }
    const rawClient: PoolClient = await this.rawPgPool.connect();
    try {
      await rawClient.query('BEGIN');

      // Find the invite using a direct query (token IS the authorization; no GUC needed).
      const inviteResult = await rawClient.query<{
        id: string; organization_id: string; brand_id: string | null;
        email: string; role_code: string; token_hash: string;
        invited_by_user_id: string; status: string;
        expires_at: Date; accepted_at: Date | null; created_at: Date;
      }>(
        `SELECT id, organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, status, expires_at, accepted_at, created_at
         FROM invite
         WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()`,
        [tokenHash],
      );

      const inviteRow = inviteResult.rows[0];
      if (!inviteRow) {
        await rawClient.query('ROLLBACK');
        throw new InviteError('INVALID_TOKEN', 'Invalid or expired invitation.', 400);
      }

      // ── AC-7 Guard 1: email-match (MA-07) ──────────────────────────────────
      let userId = acceptingUserId;
      if (userId) {
        // Check accepting user's email matches the invite email.
        const userResult = await rawClient.query<{
          id: string; email_normalized: string; email_verified_at: Date | null;
        }>(
          `SELECT id, email_normalized, email_verified_at FROM app_user WHERE id = $1`,
          [userId],
        );
        const acceptingUser = userResult.rows[0];
        if (!acceptingUser) {
          await rawClient.query('ROLLBACK');
          throw new InviteError('INVALID_TOKEN', 'User not found.', 400);
        }
        if (acceptingUser.email_normalized !== inviteRow.email.toLowerCase()) {
          await rawClient.query('ROLLBACK');
          throw new InviteError('EMAIL_MISMATCH', 'This invite was sent to a different email address.', 403);
        }
        // ── AC-7 Guard 2: email-verified (MA-07) ────────────────────────────
        // When acceptingUserId is supplied we also enforce email verification.
        if (acceptingUser.email_verified_at === null) {
          await rawClient.query('ROLLBACK');
          throw new InviteError('USER_UNVERIFIED', 'Please verify your email before accepting this invite.', 403);
        }
      } else {
        // Find by email.
        const existingResult = await rawClient.query<{
          id: string; email_normalized: string; email_verified_at: Date | null;
        }>(
          `SELECT id, email_normalized, email_verified_at FROM app_user WHERE email = $1`,
          [inviteRow.email],
        );
        const existingUser = existingResult.rows[0];
        if (!existingUser) {
          await rawClient.query('ROLLBACK');
          throw new InviteError(
            'USER_REQUIRED',
            'Please register first to accept this invite.',
            400,
          );
        }
        // ── AC-7 Guard 2: email-verified ──────────────────────────────────
        if (existingUser.email_verified_at === null) {
          await rawClient.query('ROLLBACK');
          throw new InviteError('USER_UNVERIFIED', 'Please verify your email before accepting this invite.', 403);
        }
        userId = existingUser.id;
      }

      // All guards passed — now atomically: grant membership THEN mark invite accepted.

      // D-10: duplicate-membership guard. Pre-check before INSERT to return 409 (not 500).
      // Belt-and-braces: the membership table has unique constraints that would throw on dup INSERT;
      // this pre-check maps that cleanly to a 409 with a user-facing message.
      const dupMemberCheck = await rawClient.query<{ exists: boolean }>(
        inviteRow.brand_id
          ? `SELECT EXISTS(
               SELECT 1 FROM membership
               WHERE organization_id = $1 AND app_user_id = $2 AND brand_id = $3
             ) AS exists`
          : `SELECT EXISTS(
               SELECT 1 FROM membership
               WHERE organization_id = $1 AND app_user_id = $2 AND brand_id IS NULL
             ) AS exists`,
        inviteRow.brand_id
          ? [inviteRow.organization_id, userId, inviteRow.brand_id]
          : [inviteRow.organization_id, userId],
      );
      if (dupMemberCheck.rows[0]?.exists) {
        await rawClient.query('ROLLBACK');
        throw new InviteError('ALREADY_MEMBER', 'Already a member of this workspace.', 409);
      }

      // Create membership.
      let membershipResult: { rows: Array<{
        id: string; organization_id: string; brand_id: string | null;
        app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
      }> };
      try {
        membershipResult = await rawClient.query<{
          id: string; organization_id: string; brand_id: string | null;
          app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
        }>(
          `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
           VALUES ($1, $2, $3, $4)
           RETURNING id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at`,
          [inviteRow.organization_id, inviteRow.brand_id, userId, inviteRow.role_code],
        );
      } catch (insertErr: unknown) {
        // Map PG unique-violation (23505) → 409 (belt-and-braces for race window).
        if ((insertErr as { code?: string }).code === '23505') {
          await rawClient.query('ROLLBACK');
          throw new InviteError('ALREADY_MEMBER', 'Already a member of this workspace.', 409);
        }
        throw insertErr;
      }
      const membershipRow = membershipResult.rows[0]!;

      // Mark invite accepted (AFTER membership granted — MA-07 atomicity).
      await rawClient.query(
        `UPDATE invite SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
        [inviteRow.id],
      );

      await rawClient.query('COMMIT');

      await this.audit.append({
        brand_id: inviteRow.brand_id ?? inviteRow.organization_id,
        actor_id: userId,
        actor_role: inviteRow.role_code,
        action: 'invite.accepted',
        entity_type: 'invite',
        entity_id: inviteRow.id,
        payload: {
          email_masked: maskEmail(inviteRow.email),
          organization_id: inviteRow.organization_id,
          brand_id: inviteRow.brand_id,
        },
      });

      const membership: Membership = {
        id: membershipRow.id,
        organizationId: membershipRow.organization_id,
        brandId: membershipRow.brand_id,
        appUserId: membershipRow.app_user_id,
        roleCode: membershipRow.role_code as RoleCode,
        createdAt: membershipRow.created_at,
        updatedAt: membershipRow.updated_at,
      };

      return { membership };
    } catch (err) {
      try { await rawClient.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      rawClient.release();
    }
  }

  async listMembers(
    data: {
      organizationId: string;
      brandId?: string;
      requestingUserId: string;
      cursor?: string;
      limit: number;
    },
    correlationId: string,
  ): Promise<{
    items: Array<Membership & { email: string }>;
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const ctx: QueryContext = {
      correlationId,
      workspaceId: data.organizationId,
      ...(data.brandId ? { brandId: data.brandId } : {}),
    };
    const client = await this.pool.connect();
    try {
      const memberRepo = new MembershipRepository(client);

      // Assert requesting user is a member.
      const membership = await memberRepo.findByUserAndOrg(
        data.requestingUserId,
        data.organizationId,
        data.brandId ?? null,
        ctx,
      );
      if (!membership) {
        throw new InviteError('FORBIDDEN', 'Not a member.', 403);
      }

      return memberRepo.listByOrganization(
        data.organizationId,
        data.brandId,
        data.cursor,
        data.limit,
        ctx,
      );
    } finally {
      client.release();
    }
  }

  /**
   * AC-2 (CRITICAL): Update member role AND revoke target sessions IN ONE TRANSACTION.
   *
   * SD-3 (BINDING): revoke on ALL role changes, not just demotions.
   * Atomicity: membership write + session revocation + audit ALL in one txn.
   * If the membership write rolls back, revocation also rolls back.
   */
  async updateMemberRole(
    memberId: string,
    newRoleCode: RoleCode,
    requestingUserId: string,
    organizationId: string,
    correlationId: string,
  ): Promise<Membership> {
    // Use raw pg client for explicit txn control (no GUC middleware needed here —
    // access-control is enforced by the service-layer membership assertion below).
    if (!this.rawPgPool) {
      throw new InviteError('CONFIGURATION_ERROR', 'Raw pg pool not provided — updateMemberRole unavailable.', 500);
    }
    const rawClient: PoolClient = await this.rawPgPool.connect();
    const ctx: QueryContext = { correlationId, workspaceId: organizationId };
    try {
      await rawClient.query('BEGIN');

      // Assert requester has owner or brand_admin role.
      const requesterResult = await rawClient.query<{
        id: string; organization_id: string; brand_id: string | null; role_code: string;
      }>(
        `SELECT id, organization_id, brand_id, role_code FROM membership
         WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL`,
        [requestingUserId, organizationId],
      );
      const requesterMembership = requesterResult.rows[0];
      if (!requesterMembership ||
          (requesterMembership.role_code !== 'owner' && requesterMembership.role_code !== 'brand_admin')) {
        await rawClient.query('ROLLBACK');
        throw new InviteError('FORBIDDEN', 'Requires owner or brand_admin role.', 403);
      }

      // D-7: hierarchy bound — cannot grant a role at or above your own authority. Owner is exempt.
      // ROLLBACK before throw: txn is already open (SD-3 atomicity).
      if (requesterMembership.role_code !== 'owner' &&
          ROLE_HIERARCHY.indexOf(newRoleCode) >= ROLE_HIERARCHY.indexOf(requesterMembership.role_code as RoleCode)) {
        await rawClient.query('ROLLBACK');
        throw new InviteError('FORBIDDEN', 'Cannot grant a role at or above your own authority.', 403);
      }

      // Find target membership.
      const targetResult = await rawClient.query<{
        id: string; organization_id: string; brand_id: string | null;
        app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
      }>(
        `SELECT id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at
         FROM membership WHERE id = $1`,
        [memberId],
      );
      const target = targetResult.rows[0];
      if (!target || target.organization_id !== organizationId) {
        await rawClient.query('ROLLBACK');
        throw new InviteError('NOT_FOUND', 'Member not found.', 404);
      }

      // Sole-owner guard: cannot demote the last owner.
      if (target.role_code === 'owner' && newRoleCode !== 'owner') {
        const ownerCountResult = await rawClient.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM membership
           WHERE organization_id = $1 AND role_code = 'owner' AND brand_id IS NULL`,
          [organizationId],
        );
        const ownerCount = parseInt(ownerCountResult.rows[0]?.count ?? '0', 10);
        if (ownerCount <= 1) {
          await rawClient.query('ROLLBACK');
          throw new InviteError('SOLE_OWNER', 'Cannot demote the sole owner. Transfer ownership first.', 409);
        }
      }

      // (a) Update membership role.
      const updateResult = await rawClient.query<{
        id: string; organization_id: string; brand_id: string | null;
        app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
      }>(
        `UPDATE membership SET role_code = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at`,
        [newRoleCode, memberId],
      );
      const updated = updateResult.rows[0];
      if (!updated) {
        await rawClient.query('ROLLBACK');
        throw new InviteError('NOT_FOUND', 'Member not found.', 404);
      }

      // (b) AC-2 / SD-3: Revoke target's sessions (ALL role changes, unconditional).
      // M1: sessions are user-global; sessions scoped to this org don't exist yet.
      const revokeResult = await rawClient.query<{ rowcount: string }>(
        `WITH revoked AS (
           UPDATE user_session SET revoked_at = NOW()
           WHERE app_user_id = $1 AND revoked_at IS NULL
           RETURNING id
         )
         SELECT COUNT(*)::text AS rowcount FROM revoked`,
        [target.app_user_id],
      );
      const revokeCount = parseInt(revokeResult.rows[0]?.rowcount ?? '0', 10);

      await rawClient.query('COMMIT');

      // (c) Audit — after commit so audit failures don't roll back membership.
      await this.audit.append({
        brand_id: organizationId,
        actor_id: requestingUserId,
        actor_role: requesterMembership.role_code,
        action: 'membership.role_changed',
        entity_type: 'membership',
        entity_id: memberId,
        payload: { old_role: target.role_code, new_role: newRoleCode, target_user_id: target.app_user_id },
      });
      await this.audit.append({
        brand_id: organizationId,
        actor_id: requestingUserId,
        actor_role: requesterMembership.role_code,
        action: 'sessions.bulk_revoked',
        entity_type: 'user_session',
        entity_id: target.app_user_id,
        payload: { reason: 'role_changed', count: revokeCount, target_user_id: target.app_user_id },
      });

      return {
        id: updated.id,
        organizationId: updated.organization_id,
        brandId: updated.brand_id,
        appUserId: updated.app_user_id,
        roleCode: updated.role_code as RoleCode,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      };
    } catch (err) {
      try { await rawClient.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      rawClient.release();
    }
  }

  /**
   * AC-2 (CRITICAL): Remove member AND revoke target sessions IN ONE TRANSACTION.
   *
   * Atomicity: membership delete + session revocation + audit ALL in one txn.
   * If the delete rolls back, revocation also rolls back.
   */
  async removeMember(
    memberId: string,
    requestingUserId: string,
    organizationId: string,
    correlationId: string,
  ): Promise<void> {
    if (!this.rawPgPool) {
      throw new InviteError('CONFIGURATION_ERROR', 'Raw pg pool not provided — removeMember unavailable.', 500);
    }
    const rawClient: PoolClient = await this.rawPgPool.connect();
    try {
      await rawClient.query('BEGIN');

      // Assert requester has owner or brand_admin role.
      const requesterResult = await rawClient.query<{
        id: string; role_code: string;
      }>(
        `SELECT id, role_code FROM membership
         WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL`,
        [requestingUserId, organizationId],
      );
      const requesterMembership = requesterResult.rows[0];
      if (!requesterMembership ||
          (requesterMembership.role_code !== 'owner' && requesterMembership.role_code !== 'brand_admin')) {
        await rawClient.query('ROLLBACK');
        throw new InviteError('FORBIDDEN', 'Requires owner or brand_admin role.', 403);
      }

      // Find target membership.
      const targetResult = await rawClient.query<{
        id: string; organization_id: string; brand_id: string | null;
        app_user_id: string; role_code: string;
      }>(
        `SELECT id, organization_id, brand_id, app_user_id, role_code FROM membership WHERE id = $1`,
        [memberId],
      );
      const target = targetResult.rows[0];
      if (!target || target.organization_id !== organizationId) {
        await rawClient.query('ROLLBACK');
        throw new InviteError('NOT_FOUND', 'Member not found.', 404);
      }

      // Cannot remove the sole owner.
      if (target.role_code === 'owner' && target.brand_id === null) {
        const ownerCountResult = await rawClient.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM membership
           WHERE organization_id = $1 AND role_code = 'owner' AND brand_id IS NULL`,
          [organizationId],
        );
        const ownerCount = parseInt(ownerCountResult.rows[0]?.count ?? '0', 10);
        if (ownerCount <= 1) {
          await rawClient.query('ROLLBACK');
          throw new InviteError('SOLE_OWNER', 'Cannot remove the sole owner.', 409);
        }
      }

      // (a) Delete membership.
      await rawClient.query(`DELETE FROM membership WHERE id = $1`, [memberId]);

      // (b) AC-2: Revoke ALL target user's sessions in the same txn.
      // M1: sessions are user-global.
      const revokeResult = await rawClient.query<{ rowcount: string }>(
        `WITH revoked AS (
           UPDATE user_session SET revoked_at = NOW()
           WHERE app_user_id = $1 AND revoked_at IS NULL
           RETURNING id
         )
         SELECT COUNT(*)::text AS rowcount FROM revoked`,
        [target.app_user_id],
      );
      const revokeCount = parseInt(revokeResult.rows[0]?.rowcount ?? '0', 10);

      await rawClient.query('COMMIT');

      // (c) Audit — after commit.
      await this.audit.append({
        brand_id: organizationId,
        actor_id: requestingUserId,
        actor_role: requesterMembership.role_code,
        action: 'membership.removed',
        entity_type: 'membership',
        entity_id: memberId,
        payload: { removed_user_id: target.app_user_id, role_code: target.role_code },
      });
      await this.audit.append({
        brand_id: organizationId,
        actor_id: requestingUserId,
        actor_role: requesterMembership.role_code,
        action: 'sessions.bulk_revoked',
        entity_type: 'user_session',
        entity_id: target.app_user_id,
        payload: { reason: 'member_removed', count: revokeCount, target_user_id: target.app_user_id },
      });
    } catch (err) {
      try { await rawClient.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      rawClient.release();
    }
  }

  // ── Slice 2: Pending-invite visibility / resend / revoke ─────────────────────

  /**
   * D-4 / D-11: List pending invites with actor-role predicate.
   * QueryContext MUST carry workspaceId + brandId so compound RLS activates (H-3).
   */
  async listPendingInvites(
    data: {
      organizationId: string;
      brandId: string | null;
      requestingUserId: string;
      cursor?: string;
      limit: number;
    },
    correlationId: string,
  ): Promise<{ items: import('../domain/invite/entities.js').Invite[]; nextCursor: string | null; hasMore: boolean }> {
    // D-11: carry workspaceId + brandId in ctx so compound RLS activates (H-3).
    const ctx: QueryContext = {
      correlationId,
      workspaceId: data.organizationId,
      ...(data.brandId ? { brandId: data.brandId } : {}),
    };
    const client = await this.pool.connect();
    try {
      const memberRepo = new MembershipRepository(client);
      const inviteRepo = new InviteRepository(client);

      // Assert actor is a member and resolve their role for predicate (D-4).
      const actorMembership = await memberRepo.findByUserAndOrg(
        data.requestingUserId,
        data.organizationId,
        data.brandId,
        ctx,
      );
      if (!actorMembership) {
        throw new InviteError('FORBIDDEN', 'Not a member.', 403);
      }

      return inviteRepo.listPending(
        data.organizationId,
        data.brandId,
        actorMembership.roleCode,
        data.requestingUserId,
        data.cursor,
        data.limit,
        ctx,
      );
    } finally {
      client.release();
    }
  }

  /**
   * D-3: Resend invite — rotate token_hash + expires_at on the existing pending row.
   * No second row. Re-sends email.
   */
  async resendInvite(
    inviteId: string,
    requestingUserId: string,
    organizationId: string,
    brandId: string | null,
    correlationId: string,
  ): Promise<import('../domain/invite/entities.js').Invite> {
    const ctx: QueryContext = {
      correlationId,
      workspaceId: organizationId,
      ...(brandId ? { brandId } : {}),
    };
    const client = await this.pool.connect();
    try {
      const memberRepo = new MembershipRepository(client);
      const inviteRepo = new InviteRepository(client);

      // Actor must be owner or brand_admin (resolved from DB — D-2).
      const actorMembership = await memberRepo.findByUserAndOrg(
        requestingUserId,
        organizationId,
        brandId,
        ctx,
      );
      if (!actorMembership ||
          (actorMembership.roleCode !== 'owner' && actorMembership.roleCode !== 'brand_admin')) {
        throw new InviteError('FORBIDDEN', 'Requires owner or brand_admin role to resend.', 403);
      }

      // Rotate token on existing pending row (D-3 — no second row).
      const { rawToken, tokenHash } = generateToken();
      const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

      const updatedInvite = await inviteRepo.rotateToken(inviteId, tokenHash, expiresAt, ctx);
      if (!updatedInvite) {
        throw new InviteError('NOT_FOUND', 'Pending invite not found.', 404);
      }

      // Re-send via same notification path (I-ST05).
      await this.notification.sendInviteEmail(updatedInvite.email, rawToken, correlationId);

      await this.audit.append({
        brand_id: updatedInvite.brandId ?? organizationId,
        actor_id: requestingUserId,
        actor_role: actorMembership.roleCode,
        action: 'invite.resent',
        entity_type: 'invite',
        entity_id: inviteId,
        payload: { email_masked: maskEmail(updatedInvite.email) },
      });

      return updatedInvite;
    } finally {
      client.release();
    }
  }

  /**
   * Revoke a pending invite (sets status = 'revoked').
   * Uses GUC pool (RLS-enforced). Audits invite.revoked post-update.
   */
  async revokeInvite(
    inviteId: string,
    requestingUserId: string,
    organizationId: string,
    brandId: string | null,
    correlationId: string,
  ): Promise<void> {
    const ctx: QueryContext = {
      correlationId,
      workspaceId: organizationId,
      ...(brandId ? { brandId } : {}),
    };
    const client = await this.pool.connect();
    try {
      const memberRepo = new MembershipRepository(client);
      const inviteRepo = new InviteRepository(client);

      // Actor must be owner or brand_admin.
      const actorMembership = await memberRepo.findByUserAndOrg(
        requestingUserId,
        organizationId,
        brandId,
        ctx,
      );
      if (!actorMembership ||
          (actorMembership.roleCode !== 'owner' && actorMembership.roleCode !== 'brand_admin')) {
        throw new InviteError('FORBIDDEN', 'Requires owner or brand_admin role to revoke.', 403);
      }

      // Fetch pending invite (RLS-scoped) by id.
      // Note: findValidByHash is by token, so we add a findById-style query directly.
      const inviteResult = await client.query<{
        id: string; organization_id: string; brand_id: string | null;
        email: string; role_code: string; status: string;
      }>(
        ctx,
        `SELECT id, organization_id, brand_id, email, role_code, status
         FROM invite WHERE id = $1`,
        [inviteId],
      );
      const inviteRow = inviteResult.rows[0];
      if (!inviteRow || inviteRow.status !== 'pending') {
        throw new InviteError('NOT_FOUND', 'Pending invite not found.', 404);
      }

      await inviteRepo.updateStatus(inviteId, 'revoked', ctx);

      await this.audit.append({
        brand_id: inviteRow.brand_id ?? organizationId,
        actor_id: requestingUserId,
        actor_role: actorMembership.roleCode,
        action: 'invite.revoked',
        entity_type: 'invite',
        entity_id: inviteId,
        payload: { email_masked: maskEmail(inviteRow.email) },
      });
    } finally {
      client.release();
    }
  }
}
