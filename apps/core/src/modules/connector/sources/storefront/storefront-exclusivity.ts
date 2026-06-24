/**
 * storefront-exclusivity — one storefront per brand (business rule).
 *
 * A brand represents a single commerce surface, so it may have AT MOST ONE connected storefront
 * connector. Bodd Active = Shopify, ULinen = WooCommerce — never both on one brand. This guard is
 * called at the connect choke point of every storefront connector (Shopify OAuth callback +
 * WooCommerce connect) BEFORE the instance is created, so a second, different storefront is rejected.
 *
 * Allowed (NOT blocked):
 *   - Reconnecting the SAME provider (provider === provider) — e.g. WooCommerce → WooCommerce.
 *   - Multiple accounts of the SAME provider (Gap B multi-account) — same provider.
 *   - A previously-connected storefront that is now `disconnected` — only `connected` rows count,
 *     so disconnecting Shopify frees the brand to connect WooCommerce.
 */

import type { IConnectorInstanceRepository } from '@brain/connector-core';

/** The storefront-category providers (catalog category='storefront'). Mutually exclusive per brand. */
export const STOREFRONT_PROVIDERS = ['shopify', 'woocommerce'] as const;
export type StorefrontProvider = (typeof STOREFRONT_PROVIDERS)[number];

export function isStorefrontProvider(provider: string): provider is StorefrontProvider {
  return (STOREFRONT_PROVIDERS as readonly string[]).includes(provider);
}

export class StorefrontExclusivityError extends Error {
  public readonly code = 'STOREFRONT_ALREADY_CONNECTED';
  public readonly statusCode = 409;
  constructor(public readonly existingProvider: string) {
    super(
      `This brand already has a ${existingProvider} storefront connected. ` +
        `A brand can have only one storefront — disconnect ${existingProvider} first to switch.`,
    );
    this.name = 'StorefrontExclusivityError';
  }
}

/**
 * Throw StorefrontExclusivityError if the brand already has a CONNECTED storefront of a DIFFERENT
 * provider. Call at the connect choke point before creating the new storefront instance.
 *
 * @param repo     connector-instance repository (brand-scoped via the caller's GUC/pool).
 * @param brandId  the brand being connected (server-resolved — never client input).
 * @param provider the storefront provider being connected now ('shopify' | 'woocommerce').
 */
export async function assertSingleStorefront(
  repo: IConnectorInstanceRepository,
  brandId: string,
  provider: StorefrontProvider,
): Promise<void> {
  const existing = await repo.findAllByBrand(brandId);
  const otherStorefront = existing.find(
    (c) => c.status === 'connected' && isStorefrontProvider(c.provider) && c.provider !== provider,
  );
  if (otherStorefront) {
    throw new StorefrontExclusivityError(otherStorefront.provider);
  }
}
