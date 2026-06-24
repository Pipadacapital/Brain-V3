/**
 * Brand application service.
 *
 * AC-4: currency_code, timezone, revenue_definition on brand.
 * MA-11: currency_code immutability guard (409 if any ledger rows exist).
 * MA-12: revenue_definition CHECK ('realized'|'delivered') — 'placed' excluded.
 * AC-5: onboarding_status advancement on brand create (→ 'brand_created').
 */

import { randomUUID } from 'node:crypto';
import { normalizeBrandHost } from '@brain/pixel-sdk';
import type { DbPool, QueryContext } from '@brain/db';
import type { SilverPool } from '@brain/metric-engine';
import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';
import type { AuditWriter } from '@brain/audit';

/**
 * Server-side, post-persist pixel provisioner (ADR-4). brandId comes ONLY from the
 * freshly-written brand row — never from client input (R2 invariant). Injected as a
 * closure so BrandService stays free of the pixel module's wiring.
 */
export type ProvisionPixel = (
  brandId: string,
  targetHost: string,
  idempotencyKey: string,
) => Promise<void>;
import type { Brand, CurrencyCode, BrandTimezone, RevenueDefinition } from '../domain/brand/entities.js';
import type { RoleCode } from '../domain/membership/entities.js';
import { BrandRepository } from '../infrastructure/repositories/brand.repository.js';
import { MembershipRepository } from '../infrastructure/repositories/membership.repository.js';
import { OrganizationRepository } from '../infrastructure/repositories/organization.repository.js';

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
    private readonly provisionPixel?: ProvisionPixel,
    /**
     * StarRocks Silver/Gold pool — the currency-immutability guard reads the LAKEHOUSE ledger
     * (brain_gold.gold_revenue_ledger), not the PG ledger (medallion realignment, Epic 1 / B).
     * Optional: absent (Silver down) → guard treats the brand as having no financial data yet.
     */
    private readonly srPool?: SilverPool,
  ) {}

  /**
   * Canonicalize a user-typed brand website to its registrable host.
   * Returns null for blank/absent input (skip-for-now). Throws INVALID_WEBSITE (422)
   * for a non-empty input that does not resolve to a valid host.
   */
  private normalizeDomain(domain: string | null | undefined): string | null {
    if (domain == null || domain.trim() === '') return null;
    const host = normalizeBrandHost(domain);
    if (host === null) {
      throw new BrandError('INVALID_WEBSITE', 'Enter a valid website (e.g. mystore.com).', 422);
    }
    return host;
  }

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
    // Server-authoritative canonical host (ADR-1). null = skip-for-now (no provision).
    const normalizedHost = this.normalizeDomain(data.domain);
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
          domain: normalizedHost,
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

      // Auto-provision the per-brand pixel_installation (ADR-4). brandId is taken
      // ONLY from the just-written brand.id — never a client-sent brand_id (R2).
      // Guarded by host != null (skip-for-now creates no row). Idempotent + RLS-scoped.
      if (normalizedHost !== null && this.provisionPixel) {
        await this.provisionPixel(brand.id, normalizedHost, correlationId);
      }

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
    // userId is REQUIRED here: the brand list is gated by the brand_self_read RLS policy, whose
    // membership subquery filters `app_user_id = app.current_user_id`. Without the user GUC the
    // subquery matches nothing and the list comes back empty even though brands + memberships exist.
    const ctx: QueryContext = { correlationId, workspaceId: organizationId, userId: requestingUserId };
    const client = await this.pool.connect();
    try {
      const brandRepo = new BrandRepository(client);
      const memberRepo = new MembershipRepository(client);

      // Assert org membership.
      // M1 INVARIANT: every brand-member holds a corresponding org-level membership row
      // (brand_id IS NULL) created at org-creation or org-invite time. Brand-invite (post-M1)
      // must also create an org-level row or this guard must be updated to accept brand-only
      // members. Without this invariant, brand-only members 403 here before the RLS query runs.
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

      // MA-11: currency_code immutability guard. Once financial data has been recorded for the
      // brand, its currency is locked. The SoR is now the LAKEHOUSE ledger (brain_gold.gold_revenue_
      // _ledger), not the PG ledger (medallion realignment, Epic 1 / B). Silver unavailable → fail
      // OPEN (treat as no financial data) so a transient Silver outage never blocks a legit edit.
      if (data.currencyCode !== undefined && this.srPool) {
        let hasLedgerRows = false;
        try {
          hasLedgerRows = await withSilverBrand(this.srPool, id, async (scope) => {
            const rows = await scope.runScoped<{ one: number }>(
              `SELECT 1 AS one FROM brain_gold.gold_revenue_ledger WHERE ${BRAND_PREDICATE} LIMIT 1`,
              [],
            );
            return rows.length > 0;
          });
        } catch {
          // Silver unavailable / table absent → treat as no financial data yet (fail open).
          hasLedgerRows = false;
        }
        if (hasLedgerRows) {
          throw new BrandError(
            'CURRENCY_LOCKED',
            'Currency cannot be changed after financial data has been recorded.',
            409,
          );
        }
      }

      // Canonicalize the website if this PATCH touches it (ADR-1). `domain` absent
      // from the PATCH → untouched; present + blank → null (clears); present +
      // non-empty → canonical host or 422.
      const domainProvided = Object.prototype.hasOwnProperty.call(data, 'domain');
      const normalizedHost = domainProvided ? this.normalizeDomain(data.domain) : undefined;
      const writeData = domainProvided ? { ...data, domain: normalizedHost } : data;

      const updated = await brandRepo.update(id, writeData, ctx);
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
          domain: domainProvided ? normalizedHost : undefined,
          status: data.status,
          currency_code: data.currencyCode,
          timezone: data.timezone,
          revenue_definition: data.revenueDefinition,
        },
      });

      // Auto-provision / edit-host-in-place (ADR-3/ADR-4). Fires only when the PATCH
      // set a non-null canonical host. brandId is the path-resolved id, not client body.
      if (domainProvided && normalizedHost && this.provisionPixel) {
        await this.provisionPixel(id, normalizedHost, correlationId);
      }

      return updated;
    } finally {
      client.release();
    }
  }
}
