import { describe, it, expect } from 'vitest';
import {
  ConnectorInstance,
  ConnectorFactory,
  ConnectorNotRegisteredError,
  hashToUuidShaped,
  type IConnector,
} from '../index.js';

const baseProps = () => ({
  id: 'id-1',
  brandId: 'brand-1',
  provider: 'razorpay',
  shopDomain: '',
  secretRef: 'arn:aws:secretsmanager:...:secret/x',
  status: 'connected' as const,
  healthState: 'Healthy' as const,
  safetyRating: 'safe' as const,
  connectedAt: new Date('2026-01-01T00:00:00Z'),
  disconnectedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
});

describe('ConnectorInstance (provider-agnostic)', () => {
  it('creates with empty host and no validator (credential connector)', () => {
    const inst = ConnectorInstance.create(baseProps());
    expect(inst.provider).toBe('razorpay');
    expect(inst.shopDomain).toBe('');
  });

  it('does NOT hardcode a myshopify.com rule — any host passes without a validator', () => {
    const inst = ConnectorInstance.create({ ...baseProps(), provider: 'woocommerce', shopDomain: 'shop.example.com' });
    expect(inst.shopDomain).toBe('shop.example.com');
  });

  it('enforces a provider-supplied host validator when given', () => {
    const onlyShopify = (h: string) => /\.myshopify\.com$/.test(h);
    expect(() =>
      ConnectorInstance.create({ ...baseProps(), provider: 'shopify', shopDomain: 'bad.example.com' }, onlyShopify),
    ).toThrow(/Invalid host/);
    const ok = ConnectorInstance.create({ ...baseProps(), provider: 'shopify', shopDomain: 'acme.myshopify.com' }, onlyShopify);
    expect(ok.shopDomain).toBe('acme.myshopify.com');
  });

  it('still enforces NN-2: empty secret_ref throws', () => {
    expect(() => ConnectorInstance.create({ ...baseProps(), secretRef: '' })).toThrow(/secret_ref/);
  });

  it('disconnect flips to disconnected/Disconnected/blocked', () => {
    const inst = ConnectorInstance.create(baseProps()).disconnect();
    expect(inst.status).toBe('disconnected');
    expect(inst.healthState).toBe('Disconnected');
    expect(inst.safetyRating).toBe('blocked');
  });

  it('markTokenExpired flips to error/TokenExpired/blocked', () => {
    const inst = ConnectorInstance.create(baseProps()).markTokenExpired();
    expect(inst.status).toBe('error');
    expect(inst.healthState).toBe('TokenExpired');
    expect(inst.safetyRating).toBe('blocked');
    // immutable — original is unchanged
    const orig = ConnectorInstance.create(baseProps());
    expect(orig.healthState).toBe('Healthy');
  });

  it('markRateLimited flips to error/RateLimited/degraded', () => {
    const inst = ConnectorInstance.create(baseProps()).markRateLimited();
    expect(inst.status).toBe('error');
    expect(inst.healthState).toBe('RateLimited');
    expect(inst.safetyRating).toBe('degraded');
    // immutable — original is unchanged
    const orig = ConnectorInstance.create(baseProps());
    expect(orig.healthState).toBe('Healthy');
  });

  it('markError flips to error/Failed/blocked', () => {
    const inst = ConnectorInstance.create(baseProps()).markError();
    expect(inst.status).toBe('error');
    expect(inst.healthState).toBe('Failed');
    expect(inst.safetyRating).toBe('blocked');
  });

  it('state transitions produce fresh updatedAt', () => {
    const before = new Date('2026-01-01T00:00:00Z');
    const inst = ConnectorInstance.create({ ...baseProps(), updatedAt: before });
    const afterExpired = inst.markTokenExpired();
    expect(afterExpired.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    const afterRateLimited = inst.markRateLimited();
    expect(afterRateLimited.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  // ── ad-account activation (0106) ────────────────────────────────────────────
  it('defaults activatedAt to null (isActive false) when not provided', () => {
    const inst = ConnectorInstance.create(baseProps());
    expect(inst.activatedAt).toBeNull();
    expect(inst.isActive).toBe(false);
  });

  it('activate() sets activatedAt + isActive; deactivate() clears it (both immutable)', () => {
    const inst = ConnectorInstance.create({ ...baseProps(), provider: 'meta' });
    const active = inst.activate();
    expect(active.isActive).toBe(true);
    expect(active.activatedAt).toBeInstanceOf(Date);
    expect(inst.isActive).toBe(false); // original unchanged

    const back = active.deactivate();
    expect(back.isActive).toBe(false);
    expect(back.activatedAt).toBeNull();
  });

  it('activate() is idempotent — re-activating keeps the original activatedAt', () => {
    const stamp = new Date('2026-02-02T00:00:00Z');
    const inst = ConnectorInstance.create({ ...baseProps(), provider: 'meta', activatedAt: stamp });
    const again = inst.activate();
    expect(again).toBe(inst); // same instance, no churn
    expect(again.activatedAt).toEqual(stamp);
  });
});

describe('isAdPlatformProvider (0106)', () => {
  it('classifies only the ad platforms', async () => {
    const { isAdPlatformProvider, AD_PLATFORM_PROVIDERS } = await import('../index.js');
    expect(isAdPlatformProvider('meta')).toBe(true);
    expect(isAdPlatformProvider('google_ads')).toBe(true);
    expect(isAdPlatformProvider('shopify')).toBe(false);
    expect(isAdPlatformProvider('woocommerce')).toBe(false);
    expect(isAdPlatformProvider('razorpay')).toBe(false);
    expect(isAdPlatformProvider('gokwik')).toBe(false);
    expect([...AD_PLATFORM_PROVIDERS]).toEqual(['meta', 'google_ads']);
  });
});

describe('hashToUuidShaped', () => {
  it('is deterministic and UUIDv5-shaped', () => {
    const a = hashToUuidShaped('brand:order:order.live.v1');
    const b = hashToUuidShaped('brand:order:order.live.v1');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('ConnectorFactory (Factory + Strategy)', () => {
  const stub = (provider: string): IConnector =>
    ({ provider } as unknown as IConnector);

  it('registers and resolves by provider id', () => {
    const f = new ConnectorFactory();
    f.register('shopify', () => stub('shopify'));
    expect(f.has('shopify')).toBe(true);
    expect(f.resolve('shopify').provider).toBe('shopify');
    expect(f.registeredProviders()).toEqual(['shopify']);
  });

  it('throws on unknown provider, tryResolve returns null', () => {
    const f = new ConnectorFactory();
    expect(() => f.resolve('nope')).toThrow(ConnectorNotRegisteredError);
    expect(f.tryResolve('nope')).toBeNull();
  });

  it('rejects double registration', () => {
    const f = new ConnectorFactory();
    f.register('shopify', () => stub('shopify'));
    expect(() => f.register('shopify', () => stub('shopify'))).toThrow(/already registered/);
  });
});
