/**
 * Invite application service.
 *
 * Manages invitations at org-level (brand_id=null) and brand-level (brand_id!=null).
 * Compound RLS (NN-7) enforced at DB layer.
 * Sole-Owner guard: cannot remove/demote the last owner.
 */

import { randomBytes, createHash } from 'node:crypto';
import type { DbPool, QueryContext } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import type { NotificationService } from '../../../notification/service.js';
import type { Invite } from '../domain/invite/entities.js';
import type { Membership } from '../domain/membership/entities.js';
import type { RoleCode } from '../domain/membership/entities.js';
import { INVITE_EXPIRY_DAYS } from '../domain/invite/entities.js';
import { InviteRepository, MembershipRepository, AppUserRepository } from '../infrastructure/repositories.js';
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
  constructor(
    private readonly pool: DbPool,
    private readonly audit: AuditWriter,
    private readonly notification: NotificationService,
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

      // Cannot invite as 'owner' (sole-owner protection).
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

  async acceptInvite(
    rawToken: string,
    correlationId: string,
    acceptingUserId?: string, // if already registered
    newUserPassword?: string, // if new user
  ): Promise<{ membership: Membership; newUserId?: string }> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    // Use a broad ctx for lookup (token_hash is globally unique; invite table RLS
    // requires workspace or brand GUC — we can't set both without knowing them yet).
    // For accept-invite: we find by token_hash which bypasses RLS IF the token matches.
    // This is a public endpoint where the token IS the authorization.
    const ctx: QueryContext = { correlationId };
    const client = await this.pool.connect();
    try {
      const inviteRepo = new InviteRepository(client);
      const memberRepo = new MembershipRepository(client);
      const userRepo = new AppUserRepository(client);

      // Find the invite using a superuser-style lookup (bypassing RLS for this specific case).
      // The token_hash is the authorization credential.
      // We use a raw query to find the invite regardless of GUC context.
      const inviteResult = await client.query<{
        id: string; organization_id: string; brand_id: string | null;
        email: string; role_code: string; token_hash: string;
        invited_by_user_id: string; status: string;
        expires_at: Date; accepted_at: Date | null; created_at: Date;
      }>(
        { correlationId },
        `SELECT id, organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, status, expires_at, accepted_at, created_at
         FROM invite
         WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()`,
        [tokenHash],
      );

      const inviteRow = inviteResult.rows[0];
      if (!inviteRow) {
        throw new InviteError('INVALID_TOKEN', 'Invalid or expired invitation.', 400);
      }

      const ctxWithWorkspace: QueryContext = {
        correlationId,
        workspaceId: inviteRow.organization_id,
        ...(inviteRow.brand_id ? { brandId: inviteRow.brand_id } : {}),
      };

      // Mark invite as accepted.
      await inviteRepo.markAccepted(inviteRow.id, ctxWithWorkspace);

      // Find or assert the accepting user.
      let userId = acceptingUserId;
      if (!userId) {
        // Check if user already exists with this email.
        const existingUser = await userRepo.findByEmail(inviteRow.email, ctx);
        if (existingUser) {
          userId = existingUser.id;
        } else {
          throw new InviteError(
            'USER_REQUIRED',
            'Please register first or provide credentials to accept this invite.',
            400,
          );
        }
      }

      // Create membership.
      const membership = await memberRepo.insert(
        {
          organizationId: inviteRow.organization_id,
          brandId: inviteRow.brand_id,
          appUserId: userId,
          roleCode: inviteRow.role_code as RoleCode,
        },
        ctxWithWorkspace,
      );

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

      return { membership };
    } finally {
      client.release();
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

  async updateMemberRole(
    memberId: string,
    newRoleCode: RoleCode,
    requestingUserId: string,
    organizationId: string,
    correlationId: string,
  ): Promise<Membership> {
    const ctx: QueryContext = { correlationId, workspaceId: organizationId };
    const client = await this.pool.connect();
    try {
      const memberRepo = new MembershipRepository(client);

      // Assert requester has owner or brand_admin role.
      const requesterMembership = await memberRepo.findByUserAndOrg(
        requestingUserId, organizationId, null, ctx,
      );
      if (!requesterMembership ||
          (requesterMembership.roleCode !== 'owner' && requesterMembership.roleCode !== 'brand_admin')) {
        throw new InviteError('FORBIDDEN', 'Requires owner or brand_admin role.', 403);
      }

      // Find target membership.
      const target = await memberRepo.findById(memberId, ctx);
      if (!target || target.organizationId !== organizationId) {
        throw new InviteError('NOT_FOUND', 'Member not found.', 404);
      }

      // Sole-owner guard: cannot demote the last owner.
      if (target.roleCode === 'owner' && newRoleCode !== 'owner') {
        const ownerCount = await memberRepo.countOwners(organizationId, ctx);
        if (ownerCount <= 1) {
          throw new InviteError('SOLE_OWNER', 'Cannot demote the sole owner. Transfer ownership first.', 409);
        }
      }

      const updated = await memberRepo.updateRole(memberId, newRoleCode, ctx);
      if (!updated) throw new InviteError('NOT_FOUND', 'Member not found.', 404);

      await this.audit.append({
        brand_id: organizationId,
        actor_id: requestingUserId,
        actor_role: requesterMembership.roleCode,
        action: 'membership.role_changed',
        entity_type: 'membership',
        entity_id: memberId,
        payload: { old_role: target.roleCode, new_role: newRoleCode },
      });

      return updated;
    } finally {
      client.release();
    }
  }

  async removeMember(
    memberId: string,
    requestingUserId: string,
    organizationId: string,
    correlationId: string,
  ): Promise<void> {
    const ctx: QueryContext = { correlationId, workspaceId: organizationId };
    const client = await this.pool.connect();
    try {
      const memberRepo = new MembershipRepository(client);

      const requesterMembership = await memberRepo.findByUserAndOrg(
        requestingUserId, organizationId, null, ctx,
      );
      if (!requesterMembership ||
          (requesterMembership.roleCode !== 'owner' && requesterMembership.roleCode !== 'brand_admin')) {
        throw new InviteError('FORBIDDEN', 'Requires owner or brand_admin role.', 403);
      }

      const target = await memberRepo.findById(memberId, ctx);
      if (!target || target.organizationId !== organizationId) {
        throw new InviteError('NOT_FOUND', 'Member not found.', 404);
      }

      // Cannot remove the sole owner.
      if (target.roleCode === 'owner' && target.brandId === null) {
        const ownerCount = await memberRepo.countOwners(organizationId, ctx);
        if (ownerCount <= 1) {
          throw new InviteError('SOLE_OWNER', 'Cannot remove the sole owner.', 409);
        }
      }

      await memberRepo.delete(memberId, ctx);

      await this.audit.append({
        brand_id: organizationId,
        actor_id: requestingUserId,
        actor_role: requesterMembership.roleCode,
        action: 'membership.removed',
        entity_type: 'membership',
        entity_id: memberId,
        payload: { removed_user_id: target.appUserId, role_code: target.roleCode },
      });
    } finally {
      client.release();
    }
  }
}
