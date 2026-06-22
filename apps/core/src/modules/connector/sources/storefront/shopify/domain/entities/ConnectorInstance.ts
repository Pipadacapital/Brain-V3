/**
 * BACKWARD-COMPAT RE-EXPORT SHIM.
 *
 * The neutral connector base moved to @brain/connector-core (it never belonged under the
 * Shopify source — it was the accidental "Shopify base" every other provider imported). This
 * file re-exports it so existing relative imports keep working. New code should import from
 * '@brain/connector-core' directly.
 *
 * The Shopify-specific `*.myshopify.com` host rule that USED to live on
 * `ConnectorInstance.isValidShopDomain` now lives in `../ShopifyHostPolicy` (it is a Shopify
 * concern, not a kernel concern). Shopify behavior is unchanged.
 */
export {
  ConnectorInstance,
  DEFAULT_ACCOUNT_KEY,
} from '@brain/connector-core';
export type {
  ConnectorInstanceProps,
  ConnectorStatus,
  HealthState,
  SafetyRating,
  HostValidator,
} from '@brain/connector-core';
