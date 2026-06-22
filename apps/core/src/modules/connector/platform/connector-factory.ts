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
import { Ga4ConnectorAdapter } from '../sources/analytics/ga4/Ga4ConnectorAdapter.js';

/** Construct the connector factory with all available connectors registered. */
export function buildConnectorFactory(): ConnectorFactory {
  const factory = new ConnectorFactory();

  // ── storefront ────────────────────────────────────────────────────────────────
  factory.register('shopify', () => new ShopifyConnectorAdapter());

  // ── analytics ─────────────────────────────────────────────────────────────────
  // GA4: OAuth2 or service-account. Polling source (GA4 has no inbound webhooks).
  // Sync path = ga4-repull stream-worker job. Honest-empty guard: no creds → surfaces
  // 'GA4 not connected — add credentials', never fabricates sessions.
  factory.register('ga4', () => new Ga4ConnectorAdapter());

  // Future providers register here, one line each (woocommerce, razorpay, shiprocket, ...).
  // Each is a thin IConnector adapter — never a per-source fork of the lifecycle.

  return factory;
}
