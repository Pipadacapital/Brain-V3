/**
 * catalog/registry.ts — the single source of truth (SoR) for the connector catalog.
 *
 * ADR-CM-1: This static TypeScript const is the SoR for marketplace rendering — NOT a DB table.
 * Catalog changes = code deploys. No connector_definition table, no CRUD API.
 *
 * Phase-1a binding:
 *   - shopify = oauth, available (the only connectable connector in M1)
 *   - meta, google_ads = their real connectMethod but coming_soon this slice
 *   - razorpay = credential, coming_soon this slice
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
    connectMethod: 'coming_soon',
    availability: 'coming_soon',
    description: 'WordPress storefront sync.',
  },
  // ── ads ───────────────────────────────────────────────────────────────────────
  {
    id: 'meta',
    category: 'ads',
    displayName: 'Meta Ads',
    connectMethod: 'oauth',
    availability: 'coming_soon',
    description: 'Campaign spend & performance.',
  },
  {
    id: 'google_ads',
    category: 'ads',
    displayName: 'Google Ads',
    connectMethod: 'oauth',
    availability: 'coming_soon',
    description: 'Search & shopping campaigns.',
  },
  // ── payments ──────────────────────────────────────────────────────────────────
  {
    id: 'razorpay',
    category: 'payments',
    displayName: 'Razorpay',
    connectMethod: 'credential',
    availability: 'available',
    description: 'Settlement reconciliation — net-of-fees realized revenue.',
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
