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

/**
 * ConnectorAuthField — one declarative auth/credential field for a connector.
 *
 * This is the catalog-side, framework-agnostic description of a single input a brand
 * supplies when connecting (or, for OAuth tiles, the optional BYO-app credentials). It is
 * the foundation for unifying credential storage: the `secret` flag declares, in ONE place,
 * which fields belong in the Secrets Manager bundle (storeSecret) vs the connector_instance
 * provider_config. See modules/connector/credential-schema.ts (splitConnectorCredentials).
 *
 * ADDITIVE: authFields does NOT yet drive any runtime path — the existing per-connector
 * credential branches in bootstrap/registerConnectors.ts remain the source of behavior. This
 * type mirrors the keys those branches (and apps/web credential-fields.ts) already use.
 */
export interface ConnectorAuthField {
  /** Field key — MUST match the credential key the connector's connect branch reads. */
  key: string;
  /** Human label for the connect form. */
  label: string;
  /** Input rendering hint. */
  type: 'text' | 'password' | 'url';
  /** True ⇒ store in the Secrets Manager bundle; false ⇒ non-secret provider_config value. */
  secret: boolean;
  /** When true, the field may be left blank (connect submit isn't gated on it). */
  optional?: boolean;
  /** Optional helper text. */
  hint?: string;
}

/**
 * CredentialConnectSpec — the declarative storage shape for ONE credential connector.
 *
 * This replaces the hand-written per-connector "which key is the secret bundle vs the routing
 * identifier vs the dedicated column" branches that used to live in bootstrap/registerConnectors.ts.
 * The generic connect handler reads this + authFields and needs NO connector-specific code.
 *
 * Storage model (per brand_id, see modules/connector/credential-schema.ts → planCredentialConnect):
 *   - Secrets Manager bundle  = the secret:true authFields  ∪  `bundleNonSecretFields`. The second
 *     set are NON-secret values the provider's API nonetheless needs alongside the secret to
 *     authenticate (e.g. Razorpay key_id, GoKwik appid, Shiprocket email) — they ride in the same
 *     encrypted per-brand bundle the repull/token code already reads. Nothing else goes in the bundle.
 *   - connector_instance.provider_config + the dedicated `instanceColumn` = the routing identifier
 *     (`accountKeyField` value), the safe-to-display merchant id used for webhook/repull lookup.
 */
export interface CredentialConnectSpec {
  /** authField key whose value is the per-account sub-key (secret ref) + accountKey on the row. */
  accountKeyField: string;
  /** When `accountKeyField` is optional and absent, use this field's value for the sub-key/accountKey. */
  accountKeyFallbackField?: string;
  /**
   * The connector_instance column (== provider_config key) set to the `accountKeyField` value when
   * it is present. MUST be a static, lowercase snake_case identifier (it is interpolated into SQL).
   */
  instanceColumn: string;
  /** authField key whose value becomes connector_instance.shop_domain (default '' when omitted). */
  shopDomainField?: string;
  /** NON-secret authField keys that must ALSO ride in the Secrets Manager bundle (provider auth set). */
  bundleNonSecretFields?: string[];
}

export interface ConnectorDefinition {
  /** Canonical type key — matches provider CHECK in connector_instance where it has a backend. */
  id: string;
  category: ConnectorCategory;
  displayName: string;
  connectMethod: ConnectMethod;
  /** M1 availability: 'available' = connectable NOW; 'coming_soon' = tile shown, no connect. */
  availability: 'available' | 'coming_soon';
  description: string;
  /**
   * Declarative per-connector auth/credential fields (see ConnectorAuthField). Present for
   * credential connectors and for OAuth tiles that accept optional BYO-app creds. Absent for
   * coming_soon tiles with no backend. This DRIVES the generic credential connect handler
   * (validation + the form the marketplace renders).
   */
  authFields?: ConnectorAuthField[];
  /**
   * Declarative credential-storage spec for connectMethod==='credential' connectors. DRIVES the
   * generic connect handler's secret-bundle / provider_config / column split. Omitted for OAuth
   * and coming_soon tiles.
   */
  credentialConnect?: CredentialConnectSpec;
}

/** Shared hint for OAuth "bring your own app" client credentials (all optional). */
const OAUTH_APP_HINT = "Optional — leave blank to use Brain's app";

/** The optional BYO-app OAuth credential pair, shared by every OAuth tile. */
const OAUTH_APP_FIELDS: ConnectorAuthField[] = [
  { key: 'client_id', label: 'Client ID', type: 'text', secret: false, optional: true, hint: OAUTH_APP_HINT },
  { key: 'client_secret', label: 'Client Secret', type: 'password', secret: true, optional: true, hint: OAUTH_APP_HINT },
];

export const CONNECTOR_CATALOG: readonly ConnectorDefinition[] = [
  // ── storefront ────────────────────────────────────────────────────────────────
  {
    id: 'shopify',
    category: 'storefront',
    displayName: 'Shopify',
    connectMethod: 'oauth',
    availability: 'available',
    description: 'Sync orders, products, customers.',
    authFields: OAUTH_APP_FIELDS,
  },
  {
    id: 'woocommerce',
    category: 'storefront',
    displayName: 'WooCommerce',
    connectMethod: 'credential',
    availability: 'available',
    description: 'Sync orders, products, customers, refunds.',
    authFields: [
      { key: 'site_url', label: 'Store URL', type: 'url', secret: false },
      { key: 'consumer_key', label: 'Consumer Key', type: 'text', secret: true },
      { key: 'consumer_secret', label: 'Consumer Secret', type: 'password', secret: true },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password', secret: true, optional: true },
    ],
    credentialConnect: {
      accountKeyField: 'site_url',
      instanceColumn: 'woocommerce_site_url',
      shopDomainField: 'site_url',
    },
  },
  // ── ads ───────────────────────────────────────────────────────────────────────
  {
    id: 'meta',
    category: 'ads',
    displayName: 'Meta Ads',
    connectMethod: 'oauth',
    availability: 'available',
    description: 'Campaign spend & performance.',
    authFields: OAUTH_APP_FIELDS,
  },
  {
    id: 'google_ads',
    category: 'ads',
    displayName: 'Google Ads',
    connectMethod: 'oauth',
    availability: 'available',
    description: 'Search & shopping campaigns.',
    authFields: OAUTH_APP_FIELDS,
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
    authFields: [
      { key: 'key_id', label: 'Key ID', type: 'text', secret: false },
      { key: 'key_secret', label: 'Key Secret', type: 'password', secret: true },
      // Required: the inbound webhook HMAC secret — the Razorpay webhook receiver fails closed without it.
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password', secret: true },
      { key: 'razorpay_account_id', label: 'Account ID', type: 'text', secret: false },
    ],
    credentialConnect: {
      accountKeyField: 'razorpay_account_id',
      instanceColumn: 'razorpay_account_id',
      // key_id is non-secret but the settlement-repull API client reads it from the bundle.
      bundleNonSecretFields: ['key_id'],
    },
  },
  {
    id: 'gokwik',
    category: 'payments',
    displayName: 'GoKwik',
    connectMethod: 'credential',
    availability: 'available',
    description: 'CoD verification + RTO (return-to-origin) outcome & checkout risk signal.',
    authFields: [
      { key: 'appid', label: 'App ID', type: 'text', secret: false },
      { key: 'appsecret', label: 'App Secret', type: 'password', secret: true },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password', secret: true, optional: true },
    ],
    credentialConnect: {
      accountKeyField: 'appid',
      instanceColumn: 'gokwik_appid',
      // appid is the routing id AND part of the AWB API auth set (repull reads it from the bundle).
      bundleNonSecretFields: ['appid'],
    },
  },
  {
    id: 'shopflo',
    category: 'payments',
    displayName: 'Shopflo',
    connectMethod: 'credential',
    availability: 'available',
    description: 'One-click checkout conversion & abandoned-checkout recovery signal.',
    authFields: [
      { key: 'api_token', label: 'API Access Token', type: 'password', secret: true },
      { key: 'merchant_id', label: 'Merchant ID', type: 'text', secret: false },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password', secret: true },
    ],
    credentialConnect: {
      // merchant_id is routing-only — webhook lookup reads it from the column, never the bundle.
      accountKeyField: 'merchant_id',
      instanceColumn: 'shopflo_merchant_id',
    },
  },
  // ── logistics ────────────────────────────────────────────────────────────────
  {
    id: 'shiprocket',
    category: 'logistics',
    displayName: 'Shiprocket',
    connectMethod: 'credential',
    availability: 'available',
    description: 'Shipment lifecycle, delivery & RTO outcome, courier performance.',
    authFields: [
      { key: 'email', label: 'Email', type: 'text', secret: false },
      { key: 'password', label: 'Password', type: 'password', secret: true },
      { key: 'channel_id', label: 'Channel ID', type: 'text', secret: false, optional: true },
    ],
    credentialConnect: {
      // channel_id (optional) is the routing key when given; else the email is the sub-key.
      accountKeyField: 'channel_id',
      accountKeyFallbackField: 'email',
      instanceColumn: 'shiprocket_channel_id',
      // email is non-secret but the token provider mints the JWT from {email,password} in the bundle.
      bundleNonSecretFields: ['email'],
    },
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
    connectMethod: 'oauth',
    availability: 'available',
    description:
      'Web session analytics via GA4 Data API — sessions, source/medium, revenue, conversions. ' +
      'Connect with OAuth2 or a service-account key. Sync path requires credentials to be configured.',
  },
] as const;
