/**
 * brand-resolution.test.ts — PURE (no-DB) unit tests for the brand-context resolution decision.
 *
 * Backfills coverage for fix-session-brand-context (which minted brand_id into the session JWT but
 * shipped with only a DB-gated test). selectActiveContext is the pure decision behind
 * resolveActiveContext: which membership becomes the active {brand, role} context.
 *
 * The SAFETY PROPERTY under test: a fully-onboarded user must resolve to their brand-level
 * membership (real brand_id), never the brand-less org membership (brand_id=null) which would
 * silently break every brand-scoped, RLS-anchored surface.
 */
import { describe, it, expect } from 'vitest';
import { selectActiveContext, type ResolvableMembership } from '../internal/application/auth.service.js';

const brandMembership: ResolvableMembership = {
  brandId: 'b1111111-1111-4111-8111-111111111111',
  organizationId: 'o1111111-1111-4111-8111-111111111111',
  roleCode: 'owner',
};

const brandlessOrgMembership: ResolvableMembership = {
  brandId: null,
  organizationId: 'o1111111-1111-4111-8111-111111111111',
  roleCode: 'owner',
};

describe('selectActiveContext (pure brand-resolution)', () => {
  it('mints the brand_id + role from the first (preferred) membership', () => {
    const ctx = selectActiveContext([brandMembership, null], 'complete');
    expect(ctx.brandId).toBe(brandMembership.brandId);
    expect(ctx.workspaceId).toBe(brandMembership.organizationId);
    expect(ctx.role).toBe('owner');
    expect(ctx.onboardingStatus).toBe('complete');
  });

  it('SAFETY: prefers a brand-level membership over a brand-less one (never mints brand_id=null when a brand exists)', () => {
    // Preferred (brand-level) first, brand-less fallback second → brand_id must be the real one.
    const ctx = selectActiveContext([brandMembership, brandlessOrgMembership], 'complete');
    expect(ctx.brandId).toBe(brandMembership.brandId);
  });

  it('falls back to the next membership when the preferred slot is null', () => {
    const ctx = selectActiveContext([null, brandMembership], null);
    expect(ctx.brandId).toBe(brandMembership.brandId);
    expect(ctx.role).toBe('owner');
  });

  it('returns the all-null EMPTY_CONTEXT when there is no active membership', () => {
    const ctx = selectActiveContext([null, null], 'org_created');
    expect(ctx).toEqual({ brandId: null, workspaceId: null, role: null, onboardingStatus: null });
  });

  it('carries a brand-less (pre-brand) membership honestly as brand_id=null', () => {
    const ctx = selectActiveContext([brandlessOrgMembership], 'org_created');
    expect(ctx.brandId).toBeNull();
    expect(ctx.workspaceId).toBe(brandlessOrgMembership.organizationId);
    expect(ctx.onboardingStatus).toBe('org_created');
  });

  it('takes onboardingStatus from the resolved org (null when not yet onboarded)', () => {
    expect(selectActiveContext([brandMembership], null).onboardingStatus).toBeNull();
  });
});
