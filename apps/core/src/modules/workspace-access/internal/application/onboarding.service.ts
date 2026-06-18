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
import type { Pool, PoolClient } from 'pg';
import type { DbPool, DbClient, QueryContext } from '@brain/db';
import { buildContextGucSql } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import { normalizeBrandHost } from '@brain/pixel-sdk';

import type { CurrencyCode, BrandTimezone, RevenueDefinition } from '../domain/brand/entities.js';
import {
  OrganizationRepository,
  MembershipRepository,
  BrandRepository,
} from '../infrastructure/repositories.js';
import type { ProvisionPixel } from './brand.service.js';
import { deriveSlug } from './slugify.js';

// Region derivation from currency_code (mirrors brand.service.ts:36 — kept in sync).
const CURRENCY_TO_REGION: Record<CurrencyCode, string> = {
  INR: 'IN',
  AED: 'AE',
  SAR: 'SA',
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

/**
 * Adapt a raw pg PoolClient (running inside BEGIN/COMMIT) into a DbClient so the
 * existing repositories can be reused. Sets the ctx GUCs transaction-locally via
 * set_config(..., true) before each query — the same RLS scoping the GUC pool applies,
 * but bound to THIS transaction so RLS holds under brain_app.
 */
function txnClientAdapter(raw: PoolClient): DbClient {
  return {
    async query<T = unknown>(ctx: QueryContext, sql: string, params: unknown[] = []) {
      const gucSql = buildContextGucSql(ctx);
      if (gucSql) {
        // SET LOCAL inside an open transaction scopes the GUC to the txn (validated by
        // buildContextGucSql — UUID format asserted, injection-safe).
        await raw.query(gucSql);
      }
      const result = await raw.query(sql, params as unknown[]);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
    release(): void {
      /* no-op: the txn client lifecycle is owned by provisionWorkspaceAndBrand */
    },
  };
}

export class OnboardingService {
  /**
   * @param pool          GUC-wrapped pool — used only for the pre-flight idempotency
   *                      membership read (no transaction needed there).
   * @param rawPgPool     Raw pg.Pool for the explicit BEGIN/COMMIT provisioning txn.
   * @param audit         Audit writer (organization.created + brand.created post-commit).
   * @param provisionPixel The SAME closure injected into BrandService — preserves the
   *                      feat-onboarding-website website→pixel path. Runs AFTER commit.
   */
  constructor(
    private readonly pool: DbPool,
    private readonly rawPgPool: Pool,
    private readonly audit: AuditWriter,
    private readonly provisionPixel?: ProvisionPixel,
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

    // ── Atomic provision (org + memberships + brand + status) in ONE txn ─────────
    const raw: PoolClient = await this.rawPgPool.connect();
    let organizationId = '';
    let brandId = '';
    try {
      await raw.query('BEGIN');
      // Under the prod brain_app role, RLS needs the user GUC for the membership /
      // org self-reads+writes; set it transaction-locally up front.
      const db = txnClientAdapter(raw);
      const orgRepo = new OrganizationRepository(db);
      const memberRepo = new MembershipRepository(db);
      const brandRepo = new BrandRepository(db);

      // 1. Organization — slug derived server-side (Deliverable 4) + one retry on the
      //    residual unique-violation race (the random suffix makes this near-zero).
      const orgCtx: QueryContext = { correlationId, userId: input.ownerUserId };
      let org;
      try {
        org = await orgRepo.insert(
          { name: input.workspaceName, slug: deriveSlug(input.workspaceName), ownerUserId: input.ownerUserId },
          orgCtx,
        );
      } catch (err) {
        if ((err as { code?: string })?.code === '23505') {
          org = await orgRepo.insert(
            { name: input.workspaceName, slug: deriveSlug(input.workspaceName), ownerUserId: input.ownerUserId },
            orgCtx,
          );
        } else {
          throw err;
        }
      }
      organizationId = org.id;
      const wsCtx: QueryContext = { correlationId, userId: input.ownerUserId, workspaceId: org.id };

      // Org-level owner membership.
      await memberRepo.insert(
        { organizationId: org.id, brandId: null, appUserId: input.ownerUserId, roleCode: 'owner' },
        wsCtx,
      );

      // Advance onboarding_status → org_created (forward-only).
      await orgRepo.advanceOnboardingStatus(org.id, 'org_created', 1, wsCtx);

      // 2. Brand (brandId GUC blank — brand row does not exist yet; mirrors brand.service.ts:113).
      const brand = await brandRepo.insert(
        {
          organizationId: org.id,
          displayName: input.brandDisplayName,
          domain: normalizedHost,
          regionCode,
          currencyCode,
          timezone: input.timezone ?? 'Asia/Kolkata',
          revenueDefinition: input.revenueDefinition ?? 'realized',
        },
        { ...wsCtx, brandId: '' },
      );
      brandId = brand.id;

      // Brand-level owner membership.
      await memberRepo.insert(
        { organizationId: org.id, brandId: brand.id, appUserId: input.ownerUserId, roleCode: 'owner' },
        wsCtx,
      );

      // Advance onboarding_status → brand_created (forward-only).
      await orgRepo.advanceOnboardingStatus(org.id, 'brand_created', 2, wsCtx);

      await raw.query('COMMIT');
    } catch (err) {
      try { await raw.query('ROLLBACK'); } catch { /* ignore rollback error */ }
      throw err;
    } finally {
      raw.release();
    }

    // ── Post-commit side effects (NOT inside the org/brand txn) ──────────────────
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

    // feat-onboarding-website NON-REGRESSION: provision the per-brand pixel from the
    // just-written brand.id (never client input), only when a website was given.
    if (normalizedHost !== null && this.provisionPixel) {
      await this.provisionPixel(brandId, normalizedHost, correlationId);
    }

    return { organizationId, brandId, onboardingStatus: 'brand_created', created: true };
  }
}
