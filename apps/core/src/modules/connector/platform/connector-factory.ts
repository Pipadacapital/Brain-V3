/**
 * connector-factory.ts — the application's ConnectorFactory wiring.
 *
 * Builds a ConnectorFactory (from @brain/connector-core) and registers the available connectors,
 * keyed off CONNECTOR_CATALOG provider ids. This is the runtime resolution SoR that mirrors the
 * catalog (the marketplace render SoR). Today it registers the Shopify reference adapter to prove
 * the pattern; new providers are added with one `register(...)` line each — the Open/Closed seam
 * for the connector platform.
 */
import { ConnectorFactory } from '@brain/connector-core';
import { ShopifyConnectorAdapter } from './ShopifyConnectorAdapter.js';

/** Construct the connector factory with all available connectors registered. */
export function buildConnectorFactory(): ConnectorFactory {
  const factory = new ConnectorFactory();

  // ── storefront ────────────────────────────────────────────────────────────────
  factory.register('shopify', () => new ShopifyConnectorAdapter());

  // Future providers register here, one line each (woocommerce, razorpay, shiprocket, ...).
  // Each is a thin IConnector adapter — never a per-source fork of the lifecycle.

  return factory;
}
