/**
 * Workspace (organization) application service.
 */

import { randomUUID } from 'node:crypto';
import type { DbPool, QueryContext } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import type { Organization } from '../domain/organization/entities.js';
import type { Membership } from '../domain/membership/entities.js';
import { OrganizationRepository, MembershipRepository, BrandRepository } from '../infrastructure/repositories.js';

export class WorkspaceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export class WorkspaceService {
  constructor(
    private readonly pool: DbPool,
    private readonly audit: AuditWriter,
  ) {}

  async create(
    data: { name: string; slug: string; ownerUserId: string },
    correlationId: string,
  ): Promise<{ organization: Organization; membership: Membership }> {
    const ctx: QueryContext = { correlationId };
    const client = await this.pool.connect();
    try {
      const orgRepo = new OrganizationRepository(client);
      const memberRepo = new MembershipRepository(client);

      // Check slug uniqueness.
      const existing = await orgRepo.findBySlug(data.slug, ctx);
      if (existing) {
        throw new WorkspaceError('SLUG_TAKEN', 'This workspace slug is already taken.', 409);
      }

      // Create the organization.
      const org = await orgRepo.insert(
        { name: data.name, slug: data.slug, ownerUserId: data.ownerUserId },
        ctx,
      );

      // Add the owner as org-level membership.
      const ctxWithWorkspace: QueryContext = { ...ctx, workspaceId: org.id };
      const membership = await memberRepo.insert(
        {
          organizationId: org.id,
          brandId: null,
          appUserId: data.ownerUserId,
          roleCode: 'owner',
        },
        ctxWithWorkspace,
      );

      await this.audit.append({
        brand_id: org.id,
        actor_id: data.ownerUserId,
        actor_role: 'owner',
        action: 'organization.created',
        entity_type: 'organization',
        entity_id: org.id,
        payload: { name: org.name, slug: org.slug },
        idempotency_key: randomUUID(),
      });

      return { organization: org, membership };
    } finally {
      client.release();
    }
  }

  async getById(
    id: string,
    requestingUserId: string,
    correlationId: string,
  ): Promise<Organization | null> {
    const ctx: QueryContext = { correlationId, workspaceId: id };
    const client = await this.pool.connect();
    try {
      const orgRepo = new OrganizationRepository(client);
      const memberRepo = new MembershipRepository(client);

      // Assert membership before returning data (tenant-membership check).
      const membership = await memberRepo.findByUserAndOrg(requestingUserId, id, null, ctx);
      if (!membership) {
        throw new WorkspaceError('FORBIDDEN', 'Not a member of this workspace.', 403);
      }

      return orgRepo.findById(id, ctx);
    } finally {
      client.release();
    }
  }

  async listForUser(userId: string, correlationId: string): Promise<Organization[]> {
    const ctx: QueryContext = { correlationId };
    const client = await this.pool.connect();
    try {
      const orgRepo = new OrganizationRepository(client);
      return orgRepo.findByUserId(userId, ctx);
    } finally {
      client.release();
    }
  }

  async update(
    id: string,
    data: { name?: string },
    requestingUserId: string,
    correlationId: string,
  ): Promise<Organization> {
    const ctx: QueryContext = { correlationId, workspaceId: id };
    const client = await this.pool.connect();
    try {
      const orgRepo = new OrganizationRepository(client);
      const memberRepo = new MembershipRepository(client);

      // Assert membership + role.
      const membership = await memberRepo.findByUserAndOrg(requestingUserId, id, null, ctx);
      if (!membership || (membership.roleCode !== 'owner' && membership.roleCode !== 'brand_admin')) {
        throw new WorkspaceError('FORBIDDEN', 'Requires owner or brand_admin role.', 403);
      }

      const updated = await orgRepo.update(id, data, ctx);
      if (!updated) throw new WorkspaceError('NOT_FOUND', 'Workspace not found.', 404);

      await this.audit.append({
        brand_id: id,
        actor_id: requestingUserId,
        actor_role: membership.roleCode,
        action: 'organization.updated',
        entity_type: 'organization',
        entity_id: id,
        payload: { name: data.name },
      });

      return updated;
    } finally {
      client.release();
    }
  }
}
