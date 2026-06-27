/**
 * Workspace (organization) application service.
 */

import { randomUUID } from 'node:crypto';
import type { DbPool, QueryContext } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import type { Organization } from '../domain/organization/entities.js';
import type { Membership } from '../domain/membership/entities.js';
import { OrganizationRepository } from '../infrastructure/repositories/organization.repository.js';
import { MembershipRepository } from '../infrastructure/repositories/membership.repository.js';
import { deriveSlug } from './slugify.js';

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
    // feat-onboarding-ux (Deliverable 4): slug is OPTIONAL — derived server-side
    // (deriveSlug) when absent. The frontend no longer sends or shows a slug.
    data: { name: string; slug?: string; ownerUserId: string },
    correlationId: string,
  ): Promise<{ organization: Organization; membership: Membership }> {
    const ctx: QueryContext = { correlationId };
    const client = await this.pool.connect();
    try {
      const orgRepo = new OrganizationRepository(client);
      const memberRepo = new MembershipRepository(client);

      // Provision org + org-level owner membership atomically via the SECURITY DEFINER fn (0113) — the
      // SAME RLS-safe pattern as provision_workspace_and_brand (0047). A direct orgRepo.insert under the
      // non-superuser brain_app role fails the organization FORCE-RLS WITH CHECK
      // (id = app.current_workspace_id): the id is DB-generated, so there is no way to set that GUC
      // BEFORE the insert (chicken-and-egg) → 42501. The fn runs as definer; authorization is the
      // caller's (p_owner_user_id = the authenticated session user, so a caller only ever provisions a
      // workspace they own). Slug uniqueness is now enforced atomically by the DB constraint (23505) —
      // a pre-check under RLS could not even SEE another user's org to detect the collision.
      const provision = async (slug: string): Promise<string> => {
        const res = await client.query<{ organization_id: string }>(
          ctx,
          `SELECT organization_id FROM provision_workspace($1, $2, $3, $4)`,
          [data.ownerUserId, data.name, slug, 'IN'],
        );
        return res.rows[0]!.organization_id;
      };

      // A caller-supplied slug carries an explicit uniqueness contract (409 on collision); a derived
      // slug has a random suffix and self-heals on the residual unique-violation race (retry once).
      let orgId: string;
      try {
        orgId = await provision(data.slug ?? deriveSlug(data.name));
      } catch (err) {
        if ((err as { code?: string })?.code !== '23505') throw err;
        if (data.slug) {
          throw new WorkspaceError('SLUG_TAKEN', 'This workspace slug is already taken.', 409);
        }
        try {
          orgId = await provision(deriveSlug(data.name)); // fresh random-suffixed slug
        } catch (retryErr) {
          if ((retryErr as { code?: string })?.code === '23505') {
            throw new WorkspaceError('SLUG_TAKEN', 'This workspace slug is already taken.', 409);
          }
          throw retryErr;
        }
      }

      // Read back the full entities under the now-valid workspace context — the org + membership exist,
      // so both the membership-based self_read and the workspaceId isolation policy admit the read.
      const ctxWithWorkspace: QueryContext = { ...ctx, workspaceId: orgId };
      const organization = (await orgRepo.findById(orgId, ctxWithWorkspace))!;
      const membership = (await memberRepo.findByUserAndOrg(
        data.ownerUserId,
        orgId,
        null, // org-level owner membership (brand_id NULL)
        ctxWithWorkspace,
      ))!;

      await this.audit.append({
        brand_id: orgId,
        actor_id: data.ownerUserId,
        actor_role: 'owner',
        action: 'organization.created',
        entity_type: 'organization',
        entity_id: orgId,
        payload: { name: organization.name, slug: organization.slug },
        idempotency_key: randomUUID(),
      });

      return { organization, membership };
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
    // Pass userId so app.current_user_id is set — required for the membership
    // self-read RLS path under the production brain_app role (SEC-0008-M02).
    const ctx: QueryContext = { correlationId, userId };
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
