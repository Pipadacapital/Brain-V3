/**
 * storefront-exclusivity tests — one-storefront-per-brand guard.
 */
import { describe, it, expect, vi } from 'vitest';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import { assertSingleStorefront, StorefrontExclusivityError, isStorefrontProvider } from './storefront-exclusivity.js';

const BRAND = '11111111-1111-4111-8111-111111111111';

/** Build a mock repo whose findAllByBrand returns the given instances. */
function repoWith(instances: Array<{ provider: string; status: string }>): IConnectorInstanceRepository {
  return {
    findAllByBrand: vi.fn().mockResolvedValue(instances),
  } as unknown as IConnectorInstanceRepository;
}

describe('assertSingleStorefront', () => {
  it('allows connecting when the brand has NO storefront yet', async () => {
    await expect(assertSingleStorefront(repoWith([]), BRAND, 'woocommerce')).resolves.toBeUndefined();
  });

  it('allows RECONNECTING the same provider (woocommerce → woocommerce)', async () => {
    const repo = repoWith([{ provider: 'woocommerce', status: 'connected' }]);
    await expect(assertSingleStorefront(repo, BRAND, 'woocommerce')).resolves.toBeUndefined();
  });

  it('allows additional accounts of the same provider (shopify multi-store, Gap B)', async () => {
    const repo = repoWith([{ provider: 'shopify', status: 'connected' }]);
    await expect(assertSingleStorefront(repo, BRAND, 'shopify')).resolves.toBeUndefined();
  });

  it('REJECTS a different storefront when one is already connected (Shopify→Woo)', async () => {
    const repo = repoWith([{ provider: 'shopify', status: 'connected' }]);
    await expect(assertSingleStorefront(repo, BRAND, 'woocommerce')).rejects.toBeInstanceOf(StorefrontExclusivityError);
  });

  it('REJECTS Woo→Shopify too (symmetric)', async () => {
    const repo = repoWith([{ provider: 'woocommerce', status: 'connected' }]);
    await expect(assertSingleStorefront(repo, BRAND, 'shopify')).rejects.toMatchObject({
      code: 'STOREFRONT_ALREADY_CONNECTED',
      statusCode: 409,
      existingProvider: 'woocommerce',
    });
  });

  it('allows connecting after the other storefront is DISCONNECTED', async () => {
    const repo = repoWith([{ provider: 'shopify', status: 'disconnected' }]);
    await expect(assertSingleStorefront(repo, BRAND, 'woocommerce')).resolves.toBeUndefined();
  });

  it('IGNORES non-storefront connectors (meta/gokwik) — only storefronts are exclusive', async () => {
    const repo = repoWith([
      { provider: 'meta', status: 'connected' },
      { provider: 'gokwik', status: 'connected' },
    ]);
    await expect(assertSingleStorefront(repo, BRAND, 'woocommerce')).resolves.toBeUndefined();
  });

  it('isStorefrontProvider classifies only shopify + woocommerce', () => {
    expect(isStorefrontProvider('shopify')).toBe(true);
    expect(isStorefrontProvider('woocommerce')).toBe(true);
    expect(isStorefrontProvider('meta')).toBe(false);
    expect(isStorefrontProvider('gokwik')).toBe(false);
  });
});
