/**
 * ContextService — active brand/role context resolution + brand switching.
 *
 * Owns: resolveActiveContext, switchBrandContext.
 *
 * SECURITY INVARIANTS (preserved verbatim — feat-multi-brand AC-1):
 *  - resolveActiveContext prefers a brand-level membership so a fully-onboarded user mints a
 *    real brand_id (never the brand-less org membership). The decision is the pure, unit-tested
 *    selectActiveContext.
 *  - switchBrandContext: 3-arg membership check (403 if no row); workspaceId ALWAYS from the JWT
 *    (MA-02); archived brand → 400 (MA-10); role from the BRAND-LEVEL row (MA-03); mintSessionToken
 *    DIRECTLY reusing the jti — NEVER resolveActiveContext/findActiveByUser (MA-01); brand.switch
 *    audit after the membership+archived check (MA-09); NO brandId in the membership-check ctx (MA-11).
 */

import { randomUUID } from 'node:crypto';

import type { DbPool } from '@brain/db';
import type { AuditWriter } from '@brain/audit';

import { MembershipRepository } from '../../infrastructure/repositories/membership.repository.js';
import { OrganizationRepository } from '../../infrastructure/repositories/organization.repository.js';
import { BrandRepository } from '../../infrastructure/repositories/brand.repository.js';

import {
  type ActiveContext,
  AuthError,
  EMPTY_CONTEXT,
  selectActiveContext,
  ACCESS_TOKEN_EXPIRY_SECS,
} from './shared.js';

export class ContextService {
  /**
   * @param pool          — GUC-middleware-wrapped pool.
   * @param audit         — Audit writer.
   * @param mintSessionToken — The SessionService JWT-minting primitive (MA-01: switchBrandContext
   *                           mints DIRECTLY, never via resolveActiveContext).
   */
  constructor(
    private readonly pool: DbPool,
    private readonly audit: AuditWriter,
    private readonly mintSessionToken: (userId: string, jti: string, context: ActiveContext) => string,
  ) {}

  /** Resolve the user's current active brand/role + onboardingStatus (self-read; null until onboarded). */
  async resolveActiveContext(userId: string, correlationId: string, preferredWorkspaceId?: string): Promise<ActiveContext> {
    const client = await this.pool.connect();
    try {
      const memberRepo = new MembershipRepository(client);
      const orgRepo = new OrganizationRepository(client);

      // Prefer a brand-level membership within the preferred workspace (so a fully-onboarded user
      // resolves to {brand, role}, not the brand-less org membership which would mint brand_id=null
      // and break brand-scoped surfaces). Lazy: only fetch the fallback when there's no preferred.
      const preferred = preferredWorkspaceId
        ? await memberRepo.findActiveByUserAndOrg(userId, preferredWorkspaceId, { correlationId, userId, workspaceId: preferredWorkspaceId })
        : null;
      const fallback = preferred ? null : await memberRepo.findActiveByUser(userId, { correlationId, userId });

      const chosen = preferred ?? fallback;
      if (!chosen) return EMPTY_CONTEXT;

      const org = await orgRepo.findById(chosen.organizationId, {
        correlationId,
        workspaceId: chosen.organizationId,
      });

      // The resolution decision itself is pure + unit-tested (selectActiveContext).
      return selectActiveContext([preferred, fallback], org?.onboardingStatus ?? null);
    } finally {
      client.release();
    }
  }

  // ── Switch Brand Context (MA-01/02/03/09/10/11/12) ───────────────────────────
  /**
   * Re-mint the session JWT with a verified brand-level context.
   *
   * Security contract (binding — AC-1 of feat-multi-brand):
   *  1. Membership check uses 3-arg findByUserAndOrg (non-null brand_id) → 403 if no row.
   *  2. workspaceId ALWAYS comes from the JWT (caller passes auth.workspaceId) → prevents
   *     cross-org membership spoofing (MA-02).
   *  3. Archived brand → 400 BRAND_ARCHIVED (MA-10).
   *  4. role comes from the BRAND-LEVEL membership row (MA-03).
   *  5. mintSessionToken called DIRECTLY, reusing the jti — NEVER refreshSession /
   *     resolveActiveContext / findActiveByUser (MA-01 CRITICAL: those paths have a
   *     findActiveByUser fallback that substitutes the wrong brand).
   *  6. brand.switch audit written after membership+archived check (MA-09).
   *
   * MA-13: On fresh login, findActiveByUser auto-selects the most-recently-created
   * brand-level membership row (ORDER BY brand_id IS NOT NULL DESC, created_at DESC).
   * For a multi-brand user this is always the last-created brand, not the last-used
   * brand. Users switch brands via set-brand. "Remember last active brand" is deferred.
   */
  async switchBrandContext(
    userId: string,
    jti: string,
    fromBrandId: string | null,   // auth.brandId (outgoing context), audit only
    workspaceId: string,          // auth.workspaceId from JWT — NEVER from request body (MA-02)
    requestedBrandId: string,     // body.brand_id
    correlationId: string,
  ): Promise<{ accessToken: string; expiresIn: number; context: ActiveContext }> {
    const client = await this.pool.connect();
    try {
      const memberRepo = new MembershipRepository(client);
      const brandRepo = new BrandRepository(client);

      // Step 1: Verify brand-level membership WITHOUT brandId in ctx (MA-11).
      // Setting app.current_brand_id before we have authorized access to the target brand
      // would bleed into the pooled connection — mirror set-org ctx at bff.routes.ts:315.
      const memberCtx = { correlationId, userId, workspaceId };
      // MA-11: NO brandId in ctx — setting app.current_brand_id before authorizing the target
      // brand would bleed into the pooled connection (mirror set-org ctx at bff.routes.ts:315).

      // SEC MA-02: workspaceId comes from the JWT (caller passes auth.workspaceId),
      // NEVER the request body — prevents cross-org membership spoofing.
      // Step 2: 3-arg findByUserAndOrg (non-null third arg) — returns brand-level row (MA-01/MA-03).
      const row = await memberRepo.findByUserAndOrg(userId, workspaceId, requestedBrandId, memberCtx);
      if (!row) {
        throw new AuthError('FORBIDDEN', 'Not a member of the requested brand.', 403);
      }

      // Step 3: Archived guard (MA-10) — application layer (NOT in RLS; cross-table status
      // join in a hot policy is a performance risk). Read with brand-scoped ctx (now authorized).
      // MA-12: this read must target the primary Postgres node — a create-then-switch on a read
      // replica could 403 under replica lag. M1 is single-node; mandatory revisit before any
      // read replica is introduced.
      const brandCtx = { correlationId, workspaceId, brandId: requestedBrandId };
      // MA-10: app-layer archived guard (NOT in RLS — a cross-table status join in a hot policy
      // is a perf risk).
      const brand = await brandRepo.findById(requestedBrandId, brandCtx);
      if (!brand) {
        throw new AuthError('FORBIDDEN', 'Brand not found.', 403);
      }
      if (brand.status === 'archived') {
        throw new AuthError('BRAND_ARCHIVED', 'Cannot switch to an archived brand.', 400);
      }

      // Step 4: Build context from THE BRAND-LEVEL membership row (MA-03).
      // MA-03: role comes from the BRAND-LEVEL membership row (row.roleCode) — NEVER the
      // org-level (null-brand) row, or an org-owner would be minted into a brand-analyst session.
      const context: ActiveContext = {
        brandId: row.brandId,
        workspaceId: row.organizationId,
        role: row.roleCode,
        onboardingStatus: null,
      };

      // Step 5: Direct mint, reusing the existing jti (MA-01 CRITICAL).
      // MA-01 CRITICAL: mintSessionToken DIRECTLY. NEVER refreshSession/resolveActiveContext —
      // their findActiveByUser fallback substitutes the wrong brand (context-substitution defect).
      // Reusing jti preserves the session row + revocation state (NN-3).
      const accessToken = this.mintSessionToken(userId, jti, context);

      // Step 6: Audit (MA-09) — brand.switch with from/to/workspace/role_granted.
      // Written after a successful membership+archived check. If mintSessionToken throws after
      // this append, the audit row stands (append-only, I-S06) — acceptable, matches existing
      // pattern (see session.rotated audit).
      await this.audit.append({
        brand_id: requestedBrandId,
        actor_id: userId,
        actor_role: row.roleCode,
        action: 'brand.switch',
        entity_type: 'brand',
        entity_id: requestedBrandId,
        payload: {
          from_brand_id: fromBrandId,
          to_brand_id: requestedBrandId,
          workspace_id: workspaceId,
          role_granted: row.roleCode,
        },
        idempotency_key: randomUUID(),
      });

      return { accessToken, expiresIn: ACCESS_TOKEN_EXPIRY_SECS, context };
    } finally {
      client.release();
    }
  }
}
