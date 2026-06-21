/**
 * catalog/registry.ts — the single source of truth (SoR) for the connector catalog.
 *
 * ADR-CM-1: This static TypeScript const is the SoR for marketplace rendering — NOT a DB table.
 * Catalog changes = code deploys. No connector_definition table, no CRUD API.
 *
 * Phase-1a binding (+ feat-ad-connectors Slice 1):
 *   - shopify = oauth, available
 *   - meta, google_ads = oauth, available (feat-ad-connectors Track 1 — deep ad connectors)
 *   - razorpay = credential, available
 *   - long-tail = coming_soon
 *
 * All 7 categories have ≥1 tile (success criterion #1).
 */

export type ConnectorCategory =
  | 'storefront'
  | 'ads'
  | 'payments'
  | 'logistics'
  | 'messaging'
  | 'crm'
  | 'analytics';

export type ConnectMethod = 'oauth' | 'credential' | 'coming_soon';

export interface ConnectorDefinition {
  /** Canonical type key — matches provider CHECK in connector_instance where it has a backend. */
  id: string;
  category: ConnectorCategory;
  displayName: string;
  connectMethod: ConnectMethod;
  /** M1 availability: 'available' = connectable NOW; 'coming_soon' = tile shown, no connect. */
  availability: 'available' | 'coming_soon';
  description: string;
}

export const CONNECTOR_CATALOG: readonly ConnectorDefinition[] = [
  // ── storefront ────────────────────────────────────────────────────────────────
  {
    id: 'shopify',
    category: 'storefront',
    displayName: 'Shopify',
    connectMethod: 'oauth',
    availability: 'available',
    description: 'Sync orders, products, customers.',
  },
  {
    id: 'woocommerce',
    category: 'storefront',
    displayName: 'WooCommerce',
    connectMethod: 'credential',
    availability: 'available',
    description: 'Sync orders, products, customers, refunds.',
  },
  // ── ads ───────────────────────────────────────────────────────────────────────
  {
    id: 'meta',
    category: 'ads',
    displayName: 'Meta Ads',
    connectMethod: 'oauth',
    availability: 'available',
    description: 'Campaign spend & performance.',
  },
  {
    id: 'google_ads',
    category: 'ads',
    displayName: 'Google Ads',
    connectMethod: 'oauth',
    availability: 'available',
    description: 'Search & shopping campaigns.',
  },
  // ── payments ──────────────────────────────────────────────────────────────────
  // Razorpay = payment processor (settlement). GoKwik + Shopflo = checkout/payment-gateway
  // apps (CoD, one-click checkout, RTO) — payment-layer providers, NOT storefronts or
  // logistics carriers. They are filed under sources/checkout/ in code and belong here.
  {
    id: 'razorpay',
    category: 'payments',
    displayName: 'Razorpay',
    connectMethod: 'credential',
    availability: 'available',
    description: 'Settlement reconciliation — net-of-fees realized revenue.',
  },
  {
    id: 'gokwik',
    category: 'payments',
    displayName: 'GoKwik',
    connectMethod: 'credential',
    availability: 'available',
    description: 'CoD verification + RTO (return-to-origin) outcome & checkout risk signal.',
  },
  {
    id: 'shopflo',
    category: 'payments',
    displayName: 'Shopflo',
    connectMethod: 'credential',
    availability: 'available',
    description: 'One-click checkout conversion & abandoned-checkout recovery signal.',
  },
  // ── logistics ────────────────────────────────────────────────────────────────
  {
    id: 'shiprocket',
    category: 'logistics',
    displayName: 'Shiprocket',
    connectMethod: 'coming_soon',
    availability: 'coming_soon',
    description: 'Shipping & delivery status.',
  },
  // ── messaging ────────────────────────────────────────────────────────────────
  {
    id: 'whatsapp',
    category: 'messaging',
    displayName: 'WhatsApp',
    connectMethod: 'coming_soon',
    availability: 'coming_soon',
    description: 'Customer messaging.',
  },
  // ── crm ──────────────────────────────────────────────────────────────────────
  {
    id: 'hubspot',
    category: 'crm',
    displayName: 'HubSpot',
    connectMethod: 'coming_soon',
    availability: 'coming_soon',
    description: 'CRM contacts & deals.',
  },
  // ── analytics ────────────────────────────────────────────────────────────────
  {
    id: 'ga4',
    category: 'analytics',
    displayName: 'Google Analytics 4',
    connectMethod: 'coming_soon',
    availability: 'coming_soon',
    description: 'Web analytics.',
  },
] as const;
