/**
 * Brand application service.
 *
 * AC-4: currency_code, timezone, revenue_definition on brand.
 * MA-11: currency_code immutability guard (409 if any ledger rows exist).
 * MA-12: revenue_definition CHECK ('realized'|'delivered') — 'placed' excluded.
 * AC-5: onboarding_status advancement on brand create (→ 'brand_created').
 */

import { randomUUID } from 'node:crypto';
import type { DbPool, QueryContext } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import type { Brand, CurrencyCode, BrandTimezone, RevenueDefinition } from '../domain/brand/entities.js';
import type { RoleCode } from '../domain/membership/entities.js';
import { BrandRepository, MembershipRepository, OrganizationRepository } from '../infrastructure/repositories.js';

// Region derivation from currency_code (AC-4, plan §4).
const CURRENCY_TO_REGION: Record<CurrencyCode, string> = {
  INR: 'IN',
  AED: 'AE',
  SAR: 'SA',
};

function deriveRegionCode(currencyCode: CurrencyCode): string {
  return CURRENCY_TO_REGION[currencyCode] ?? 'IN';
}

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
    data: {
      organizationId: string;
      displayName: string;
      domain?: string | null;
      requestingUserId: string;
      requestingRole: RoleCode;
      currencyCode?: CurrencyCode;
      timezone?: BrandTimezone;
      revenueDefinition?: RevenueDefinition;
    },
    correlationId: string,
  ): Promise<Brand> {
    const currencyCode: CurrencyCode = data.currencyCode ?? 'INR';
    const regionCode = deriveRegionCode(currencyCode);
    const ctx: QueryContext = { correlationId, workspaceId: data.organizationId };
    const client = await this.pool.connect();
    try {
      const brandRepo = new BrandRepository(client);
      const memberRepo = new MembershipRepository(client);
      const orgRepo = new OrganizationRepository(client);

      // Assert org membership + role.
      const membership = await memberRepo.findByUserAndOrg(data.requestingUserId, data.organizationId, null, ctx);
      if (!membership || (membership.roleCode !== 'owner' && membership.roleCode !== 'brand_admin')) {
        throw new BrandError('FORBIDDEN', 'Requires owner or brand_admin role to create a brand.', 403);
      }

      // Create brand.
      const brand = await brandRepo.insert(
        {
          organizationId: data.organizationId,
          displayName: data.displayName,
          domain: data.domain,
          regionCode,
          currencyCode,
          timezone: data.timezone ?? 'Asia/Kolkata',
          revenueDefinition: data.revenueDefinition ?? 'realized',
        },
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

      // AC-5: Advance onboarding_status → 'brand_created' (forward-only).
      // M1: onboarding_status tracks first-brand onboarding only; multi-brand onboarding
      // is post-M1 (routes via dashboard onboarding-progress widget).
      await orgRepo.advanceOnboardingStatus(
        data.organizationId,
        'brand_created',
        2,
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
          currency_code: brand.currencyCode,
          timezone: brand.timezone,
          revenue_definition: brand.revenueDefinition,
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

      return brandRepo.findByOrganizationId(organizationId, cursor, limit, ctx);
    } finally {
      client.release();
    }
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

      // MA-11: currency_code immutability guard.
      if (data.currencyCode !== undefined) {
        // Check if any ledger row exists for this brand.
        try {
          const ledgerCheck = await client.query<{ exists: boolean }>(
            ctx,
            `SELECT EXISTS (
               SELECT 1 FROM realized_revenue_ledger WHERE brand_id = $1 LIMIT 1
             ) AS exists`,
            [id],
          );
          const hasLedgerRows = ledgerCheck.rows[0]?.exists === true;
          if (hasLedgerRows) {
            throw new BrandError(
              'CURRENCY_LOCKED',
              'Currency cannot be changed after financial data has been recorded.',
              409,
            );
          }
        } catch (err) {
          // PG error 42P01 = undefined_table (table doesn't exist yet in M1) → treat as no ledger rows.
          const pgErr = err as { code?: string };
          if (pgErr?.code !== '42P01') {
            // If it's a BrandError (CURRENCY_LOCKED) re-throw it
            if (err instanceof BrandError) throw err;
            // Other DB errors — check if it's our own BrandError first
            throw err;
          }
          // Table doesn't exist yet → no ledger rows → allow currency change.
        }
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
        payload: {
          display_name: data.displayName,
          domain: data.domain,
          status: data.status,
          currency_code: data.currencyCode,
          timezone: data.timezone,
          revenue_definition: data.revenueDefinition,
        },
      });

      return updated;
    } finally {
      client.release();
    }
  }
}
