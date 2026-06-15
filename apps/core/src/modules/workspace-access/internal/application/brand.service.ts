/**
 * Brand application service.
 */

import { randomUUID } from 'node:crypto';
import type { DbPool, QueryContext } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import type { Brand } from '../domain/brand/entities.js';
import type { RoleCode } from '../domain/membership/entities.js';
import { BrandRepository, MembershipRepository } from '../infrastructure/repositories.js';

export class BrandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'BrandError';
  }
}

export class BrandService {
  constructor(
    private readonly pool: DbPool,
    private readonly audit: AuditWriter,
  ) {}

  async create(
    data: { organizationId: string; displayName: string; domain?: string | null; requestingUserId: string; requestingRole: RoleCode },
    correlationId: string,
  ): Promise<Brand> {
    const ctx: QueryContext = { correlationId, workspaceId: data.organizationId };
    const client = await this.pool.connect();
    try {
      const brandRepo = new BrandRepository(client);
      const memberRepo = new MembershipRepository(client);

      // Assert org membership + role.
      const membership = await memberRepo.findByUserAndOrg(data.requestingUserId, data.organizationId, null, ctx);
      if (!membership || (membership.roleCode !== 'owner' && membership.roleCode !== 'brand_admin')) {
        throw new BrandError('FORBIDDEN', 'Requires owner or brand_admin role to create a brand.', 403);
      }

      // Create brand.
      const brand = await brandRepo.insert(
        { organizationId: data.organizationId, displayName: data.displayName, domain: data.domain },
        { ...ctx, brandId: '' }, // Brand doesn't exist yet; bypass brandId GUC for insert
      );

      // Add creating user as brand-level owner membership.
      await memberRepo.insert(
        {
          organizationId: data.organizationId,
          brandId: brand.id,
          appUserId: data.requestingUserId,
          roleCode: 'owner',
        },
        ctx,
      );

      await this.audit.append({
        brand_id: brand.id,
        actor_id: data.requestingUserId,
        actor_role: membership.roleCode,
        action: 'brand.created',
        entity_type: 'brand',
        entity_id: brand.id,
        payload: {
          organization_id: data.organizationId,
          display_name: brand.displayName,
        },
        idempotency_key: randomUUID(),
      });

      return brand;
    } finally {
      client.release();
    }
  }

  async getById(
    id: string,
    requestingUserId: string,
    organizationId: string,
    correlationId: string,
  ): Promise<Brand | null> {
    const ctx: QueryContext = { correlationId, brandId: id, workspaceId: organizationId };
    const client = await this.pool.connect();
    try {
      const brandRepo = new BrandRepository(client);
      const memberRepo = new MembershipRepository(client);

      // Assert brand OR org membership (either gives access to brand details).
      const orgMembership = await memberRepo.findByUserAndOrg(requestingUserId, organizationId, null, ctx);
      if (!orgMembership) {
        const brandMembership = await memberRepo.findByUserAndOrg(requestingUserId, organizationId, id, ctx);
        if (!brandMembership) {
          throw new BrandError('FORBIDDEN', 'Not a member of this brand or workspace.', 403);
        }
      }

      return brandRepo.findById(id, ctx);
    } finally {
      client.release();
    }
  }

  async list(
    organizationId: string,
    requestingUserId: string,
    cursor: string | undefined,
    limit: number,
    correlationId: string,
  ): Promise<{ items: Brand[]; nextCursor: string | null; hasMore: boolean }> {
    const ctx: QueryContext = { correlationId, workspaceId: organizationId };
    const client = await this.pool.connect();
    try {
      const brandRepo = new BrandRepository(client);
      const memberRepo = new MembershipRepository(client);

      // Assert org membership.
      const membership = await memberRepo.findByUserAndOrg(requestingUserId, organizationId, null, ctx);
      if (!membership) {
        throw new BrandError('FORBIDDEN', 'Not a member of this workspace.', 403);
      }

      // For non-owner/admin, only return brands they're a member of.
      // For owner/admin, return all brands in the org.
      // M1 simplification: return all brands visible by org membership.
      return brandRepo.findByOrganizationId(organizationId, cursor, limit, ctx);
    } finally {
      client.release();
    }
  }

  async update(
    id: string,
    data: { displayName?: string; domain?: string | null; status?: 'active' | 'archived' },
    requestingUserId: string,
    organizationId: string,
    correlationId: string,
  ): Promise<Brand> {
    const ctx: QueryContext = { correlationId, brandId: id, workspaceId: organizationId };
    const client = await this.pool.connect();
    try {
      const brandRepo = new BrandRepository(client);
      const memberRepo = new MembershipRepository(client);

      // Assert org membership + role.
      const membership = await memberRepo.findByUserAndOrg(requestingUserId, organizationId, null, ctx);
      if (!membership || (membership.roleCode !== 'owner' && membership.roleCode !== 'brand_admin')) {
        throw new BrandError('FORBIDDEN', 'Requires owner or brand_admin role.', 403);
      }

      const updated = await brandRepo.update(id, data, ctx);
      if (!updated) throw new BrandError('NOT_FOUND', 'Brand not found.', 404);

      await this.audit.append({
        brand_id: id,
        actor_id: requestingUserId,
        actor_role: membership.roleCode,
        action: 'brand.updated',
        entity_type: 'brand',
        entity_id: id,
        payload: { display_name: data.displayName, domain: data.domain, status: data.status },
      });

      return updated;
    } finally {
      client.release();
    }
  }
}
