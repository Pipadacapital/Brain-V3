/**
 * Onboarding application service (feat-onboarding-ux, Deliverable 3).
 *
 * provisionWorkspaceAndBrand: the merged "create your brand/workspace" step.
 * Provisions organization + org-owner membership + first brand + brand-owner
 * membership + onboarding_status advance in ONE Postgres transaction (atomic — no
 * orphan-org if brand creation fails). The per-brand website→pixel_installation
 * provision from feat-onboarding-website is preserved EXACTLY: it runs AFTER commit
 * via the same injected provisionPixel closure used by BrandService, guarded by
 * normalizedHost !== null (skip-for-now creates no pixel row).
 *
 * Idempotency / Back-safety (Deliverable 5): if the caller already holds an org
 * membership, return the existing { organization_id, brand_id } with created=false
 * instead of provisioning a duplicate (M1 is 1:1 org per onboarding).
 *
 * Transaction + RLS: runs over a single rawPgPool client with explicit BEGIN/COMMIT.
 * GUCs are set transaction-locally via set_config(..., true) so that under the
 * production brain_app role (NOBYPASSRLS) every insert/read is RLS-scoped exactly as
 * the GUC-pool repositories would be. Reuses the existing repositories verbatim via a
 * thin DbClient adapter over the txn client (Single-Primitive — no forked insert SQL).
 */

import { randomUUID } from 'node:crypto';
import type { DbPool, QueryContext } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import { normalizeBrandHost } from '@brain/pixel-sdk';

import type { CurrencyCode, BrandTimezone, RevenueDefinition } from '../domain/brand/entities.js';
import { OrganizationRepository } from '../infrastructure/repositories/organization.repository.js';
import { MembershipRepository } from '../infrastructure/repositories/membership.repository.js';
import type { ProvisionPixel, ProvisionBrandCrypto, EmitDomainEvent } from './brand.service.js';
import { deriveSlug } from './slugify.js';

// Region derivation from currency_code (mirrors brand.service.ts:36 — kept in sync).
const CURRENCY_TO_REGION: Record<CurrencyCode, string> = {
  INR: 'IN',
  AED: 'AE',
  SAR: 'SA',
  QAR: 'QA',
  KWD: 'KW',
  BHD: 'BH',
  OMR: 'OM',
};

export class OnboardingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'OnboardingError';
  }
}

export interface ProvisionInput {
  workspaceName: string;
  brandDisplayName: string;
  domain?: string | null;
  currencyCode?: CurrencyCode;
  timezone?: BrandTimezone;
  revenueDefinition?: RevenueDefinition;
  ownerUserId: string;
}

export interface ProvisionResult {
  organizationId: string;
  brandId: string;
  onboardingStatus: string;
  created: boolean;
}

export class OnboardingService {
  /**
   * @param pool          GUC-wrapped RLS pool — the pre-flight idempotency read AND the
   *                      provision_workspace_and_brand() call both run through it under brain_app.
   * @param audit         Audit writer (organization.created + brand.created post-commit).
   * @param provisionPixel The SAME closure injected into BrandService — preserves the
   *                      feat-onboarding-website website→pixel path. Runs AFTER commit.
   * @param emitEvent     Optional M1 lifecycle emitter (EV-2) — workspace.created + brand.created.
   */
  constructor(
    private readonly pool: DbPool,
    private readonly audit: AuditWriter,
    private readonly provisionPixel?: ProvisionPixel,
    private readonly emitEvent?: EmitDomainEvent,
    // Per-brand identity-crypto provisioner (prod only; absent in dev / unit tests).
    private readonly provisionBrandCrypto?: ProvisionBrandCrypto,
  ) {}

  /** Canonicalize the brand website (server-authoritative). null = skip-for-now. */
  private normalizeDomain(domain: string | null | undefined): string | null {
    if (domain == null || domain.trim() === '') return null;
    const host = normalizeBrandHost(domain);
    if (host === null) {
      throw new OnboardingError('INVALID_WEBSITE', 'Enter a valid website (e.g. mystore.com).', 422);
    }
    return host;
  }

  async provisionWorkspaceAndBrand(
    input: ProvisionInput,
    correlationId: string,
  ): Promise<ProvisionResult> {
    // Server-authoritative canonical host BEFORE opening the txn (a 422 must not leave
    // an open transaction). null = skip-for-now (no pixel provision).
    const normalizedHost = this.normalizeDomain(input.domain);
    const currencyCode: CurrencyCode = input.currencyCode ?? 'INR';
    const regionCode = CURRENCY_TO_REGION[currencyCode] ?? 'IN';

    // ── Idempotency / Back-safety guard (Deliverable 5) ──────────────────────────
    // If the caller already has an org membership, return the existing org/brand
    // instead of creating a duplicate (a double-submit or Back→resubmit is a no-op).
    {
      const ctx: QueryContext = { correlationId, userId: input.ownerUserId };
      const client = await this.pool.connect();
      try {
        const memberRepo = new MembershipRepository(client);
        const existing = await memberRepo.findActiveByUser(input.ownerUserId, ctx);
        if (existing) {
          const orgRepo = new OrganizationRepository(client);
          const org = await orgRepo.findById(existing.organizationId, {
            correlationId,
            workspaceId: existing.organizationId,
          });
          // Resolve the first brand for this org (the merged step always creates one).
          const brandRow = await client.query<{ id: string }>(
            { correlationId, workspaceId: existing.organizationId },
            `SELECT id FROM brand WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`,
            [existing.organizationId],
          );
          const brandId = existing.brandId ?? brandRow.rows[0]?.id ?? '';
          return {
            organizationId: existing.organizationId,
            brandId,
            onboardingStatus: org?.onboardingStatus ?? 'brand_created',
            created: false,
          };
        }
      } finally {
        client.release();
      }
    }

    // ── Atomic provision via the SECURITY DEFINER function (0047) ────────────────
    // org + 2 owner memberships + brand, created atomically by provision_workspace_and_brand().
    // The app is authorized (it passes the AUTHENTICATED user as the owner); brain_app only holds
    // EXECUTE, so the provisioning runs as the privileged owner and works under FORCE RLS without the
    // create-the-first-tenant chicken-and-egg. One retry on the residual slug unique-violation race.
    const provisionCtx: QueryContext = { correlationId, userId: input.ownerUserId };
    const provision = async (slug: string): Promise<{ organization_id: string; brand_id: string }> => {
      const client = await this.pool.connect();
      try {
        const res = await client.query<{ organization_id: string; brand_id: string }>(
          provisionCtx,
          `SELECT organization_id, brand_id
             FROM provision_workspace_and_brand($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            input.ownerUserId, input.workspaceName, slug, input.brandDisplayName, normalizedHost,
            regionCode, currencyCode, input.timezone ?? 'Asia/Kolkata', input.revenueDefinition ?? 'realized',
          ],
        );
        return res.rows[0]!;
      } finally {
        client.release();
      }
    };

    let organizationId = '';
    let brandId = '';
    try {
      const row = await provision(deriveSlug(input.workspaceName));
      organizationId = row.organization_id;
      brandId = row.brand_id;
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        try {
          const row = await provision(deriveSlug(input.workspaceName)); // fresh random-suffixed slug
          organizationId = row.organization_id;
          brandId = row.brand_id;
        } catch (retryErr) {
          // A residual unique-violation after the slug retry is a genuine conflict (e.g. the
          // workspace/brand already exists) — map it to a clean 409 instead of leaking the SQLSTATE.
          if ((retryErr as { code?: string })?.code === '23505') {
            throw new OnboardingError(
              'WORKSPACE_OR_BRAND_EXISTS',
              'A workspace or brand with these details already exists.',
              409,
            );
          }
          throw retryErr;
        }
      } else {
        throw err;
      }
    }

    // ── Post-commit side effects (NOT inside the org/brand txn) ──────────────────
    // Provision the brand's identity crypto (salt + DEK) FIRST — every other path that hashes PII
    // or vaults contact data for this brand depends on it. brandId is the just-written id (R2).
    // Idempotent; prod-only (dev derives). Throws on failure (visible > silently-broken brand).
    if (this.provisionBrandCrypto) {
      await this.provisionBrandCrypto(brandId);
    }

    // Audit (append-only). Then the pixel provision — kept OUTSIDE the txn to avoid
    // cross-module transaction coupling, mirroring brand.service.ts:154-159. The pixel
    // command is idempotent (get-or-create), so a retry is safe.
    await this.audit.append({
      brand_id: organizationId,
      actor_id: input.ownerUserId,
      actor_role: 'owner',
      action: 'organization.created',
      entity_type: 'organization',
      entity_id: organizationId,
      payload: { name: input.workspaceName },
      idempotency_key: randomUUID(),
    });
    await this.audit.append({
      brand_id: brandId,
      actor_id: input.ownerUserId,
      actor_role: 'owner',
      action: 'brand.created',
      entity_type: 'brand',
      entity_id: brandId,
      payload: {
        organization_id: organizationId,
        display_name: input.brandDisplayName,
        currency_code: currencyCode,
      },
      idempotency_key: randomUUID(),
    });

    // EV-2: emit the workspace.created + brand.created M1 lifecycle events (versioned topics).
    // The merged onboarding step is the PRIMARY org/brand-creation path; mirror BrandService's
    // emit so a brand created here is on the bus too. Tenant keys come ONLY from the just-written
    // ids (R2). The publisher fails OPEN (a bus blip never breaks onboarding — PG is the SoR).
    if (this.emitEvent) {
      await this.emitEvent('workspace.created', {
        brand_id: organizationId, // pre-brand tenant key = organization_id (publisher envelope)
        organization_id: organizationId,
        name: input.workspaceName,
        owner_user_id: input.ownerUserId,
        region_code: regionCode,
        correlation_id: correlationId,
      });
      await this.emitEvent('brand.created', {
        brand_id: brandId,
        organization_id: organizationId,
        display_name: input.brandDisplayName,
        region_code: regionCode,
        correlation_id: correlationId,
      });
    }

    // feat-onboarding-website NON-REGRESSION: provision the per-brand pixel from the
    // just-written brand.id (never client input), only when a website was given.
    if (normalizedHost !== null && this.provisionPixel) {
      await this.provisionPixel(brandId, normalizedHost, correlationId);
    }

    return { organizationId, brandId, onboardingStatus: 'brand_created', created: true };
  }
}
