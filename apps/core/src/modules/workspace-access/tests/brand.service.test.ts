/**
 * BrandService unit tests — EV-2 brand.created M1 lifecycle event emit.
 *
 * Asserts the brand-create path publishes the versioned brand.created event with the
 * just-written brand.id as the tenant key (R2 — never client-sent), and that the emit
 * is optional (absent emitter → create still succeeds).
 */

import { describe, it, expect, vi } from 'vitest';

import { BrandService } from '../internal/application/brand.service.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const BRAND_ID = '33333333-3333-4333-8333-333333333333';
const CORR = 'corr-brand-ev2';

function makeBrandService(
  emitEvent?: ReturnType<typeof vi.fn>,
  provisionBrandCrypto?: ReturnType<typeof vi.fn>,
) {
  const brandRow = {
    id: BRAND_ID,
    organization_id: ORG_ID,
    display_name: 'Acme',
    domain: null,
    status: 'active',
    region_code: 'IN',
    currency_code: 'INR',
    timezone: 'Asia/Kolkata',
    revenue_definition: 'realized',
    created_at: new Date(),
    updated_at: new Date(),
  };
  const ownerMembership = {
    id: 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm',
    organization_id: ORG_ID,
    brand_id: null,
    app_user_id: USER_ID,
    role_code: 'owner',
    created_at: new Date(),
    updated_at: new Date(),
  };

  const mockClient = {
    query: vi.fn().mockImplementation(async (_ctx: unknown, sql: string) => {
      if (sql.includes('INSERT INTO brand ')) return { rows: [brandRow], rowCount: 1 };
      if (sql.includes('INSERT INTO membership')) return { rows: [ownerMembership], rowCount: 1 };
      if (sql.includes('FROM membership')) return { rows: [ownerMembership], rowCount: 1 }; // findByUserAndOrg
      return { rows: [], rowCount: 0 }; // UPDATE organization (advanceOnboardingStatus)
    }),
    release: vi.fn(),
  };
  const mockPool = {
    connect: vi.fn().mockResolvedValue(mockClient),
    end: vi.fn().mockResolvedValue(undefined),
  };
  const mockAudit = {
    append: vi.fn().mockResolvedValue({ id: 0n, entry_hash: 'abc' }),
    getRecentEntries: vi.fn().mockResolvedValue([]),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // args: pool, audit, provisionPixel, provisionBrandCrypto, srPool, emitEvent
  const service = new BrandService(mockPool as any, mockAudit as any, undefined, provisionBrandCrypto, undefined, emitEvent);
  return { service };
}

describe('BrandService.create — EV-2 brand.created emit', () => {
  it('emits brand.created with the just-written brand.id as the tenant key', async () => {
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const { service } = makeBrandService(emitEvent);

    await service.create(
      { organizationId: ORG_ID, displayName: 'Acme', requestingUserId: USER_ID, requestingRole: 'owner' },
      CORR,
    );

    expect(emitEvent).toHaveBeenCalledTimes(1);
    const [eventName, payload] = emitEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(eventName).toBe('brand.created');
    expect(payload['brand_id']).toBe(BRAND_ID); // R2 — server-resolved, never client-sent
    expect(payload['organization_id']).toBe(ORG_ID);
    expect(payload['region_code']).toBe('IN');
    expect(payload['correlation_id']).toBe(CORR);
  });

  it('does not throw when no emitter is wired (emit is optional)', async () => {
    const { service } = makeBrandService(undefined);
    await expect(
      service.create(
        { organizationId: ORG_ID, displayName: 'Acme', requestingUserId: USER_ID, requestingRole: 'owner' },
        CORR,
      ),
    ).resolves.toMatchObject({ id: BRAND_ID });
  });
});

describe('BrandService.create — per-brand crypto provisioning (prod)', () => {
  it('provisions brand crypto with the just-written brand.id (R2)', async () => {
    const provisionBrandCrypto = vi.fn().mockResolvedValue(undefined);
    const { service } = makeBrandService(undefined, provisionBrandCrypto);

    await service.create(
      { organizationId: ORG_ID, displayName: 'Acme', requestingUserId: USER_ID, requestingRole: 'owner' },
      CORR,
    );

    expect(provisionBrandCrypto).toHaveBeenCalledTimes(1);
    expect(provisionBrandCrypto).toHaveBeenCalledWith(BRAND_ID); // server-resolved id, never client-sent
  });

  it('propagates a provisioning failure (fail visible, not a silently-broken brand)', async () => {
    const provisionBrandCrypto = vi.fn().mockRejectedValue(new Error('KMS unavailable'));
    const { service } = makeBrandService(undefined, provisionBrandCrypto);

    await expect(
      service.create(
        { organizationId: ORG_ID, displayName: 'Acme', requestingUserId: USER_ID, requestingRole: 'owner' },
        CORR,
      ),
    ).rejects.toThrow('KMS unavailable');
  });
});
