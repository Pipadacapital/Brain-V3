/**
 * ShopifyHostPolicy — the Shopify-specific shop-domain rule (NN-4).
 *
 * This rule USED to live on the neutral `ConnectorInstance.isValidShopDomain` static, which
 * meant every other provider's connector accidentally inherited a Shopify host concept. The
 * neutral kernel (@brain/connector-core) now knows NO provider host rule; this Shopify policy is
 * the SINGLE home of the `*.myshopify.com` rule and is supplied to the kernel as a HostValidator
 * strategy whenever a Shopify ConnectorInstance is created. Shopify behavior is unchanged.
 */
import {
  ConnectorInstance,
  type ConnectorInstanceProps,
  type HostValidator,
} from '@brain/connector-core';

/** Shopify shop-domain rule: must be `<store>.myshopify.com` (NN-4). */
export const isValidShopDomain: HostValidator = (shopDomain: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopDomain);

/**
 * Create a Shopify ConnectorInstance with the Shopify host rule enforced.
 * Equivalent to the old `ConnectorInstance.create` behavior for Shopify (NN-4 + NN-2).
 */
export function createShopifyConnectorInstance(props: ConnectorInstanceProps): ConnectorInstance {
  return ConnectorInstance.create(props, isValidShopDomain);
}
