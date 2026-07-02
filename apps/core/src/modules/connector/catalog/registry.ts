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
  /**
   * Secret-bundle keys that Brain MINTS at connect-time (cryptographically random) when the merchant
   * did NOT supply them. Unlike `bundleNonSecretFields` (copied from the form), these have no form
   * input — Brain generates the value and surfaces it back ONCE so the merchant can paste it into the
   * provider dashboard. Used for Shiprocket's `webhook_secret`: Shiprocket's tracking webhook sends a
   * static X-Api-Key, and the merchant configures that key in their dashboard — so Brain generates the
   * token, stores it as `webhook_secret`, and the connect response returns it for the merchant to copy.
   * (See credential-schema.ts → provisionGeneratedSecrets.)
   */
  generatedSecretFields?: string[];
  /**
   * The inbound-webhook routing header the provider must send so the WebhookPipeline can resolve this
   * tenant (e.g. Shiprocket's `x-shiprocket-channel-id`). Surfaced in the connect response next to the
   * webhook URL + generated token so the connect UI can tell the merchant exactly what to configure.
   * Its VALUE is the connector's accountKey (channel_id, else the email fallback).
   */
  webhookRoutingHeader?: string;
}

/**
 * ByoAppSetup — declarative setup instructions surfaced to the merchant when a connector
 * requires its own OAuth app. Rendered by the connect UI as a copy-buttoned panel.
 *
 * `redirectUrl` is emitted as '' from the catalog and filled at request time from
 * config.shopifyCallbackUrl (the public OAuth callback URL), because the catalog is
 * static-typed compile-time state.
 */
export interface ByoAppSetup {
  /** Public OAuth redirect URL the merchant must paste into their Custom App config. */
  redirectUrl: string;
  /** OAuth scope list the merchant must enable — must match the InitiateOAuthCommand scopes. */
  scopes: readonly string[];
  /** Optional external docs link. */
  docsUrl?: string;
}

/**
 * Shopify's required OAuth scopes — hoisted here so the catalog can hand them to the connect
 * UI's setup panel and InitiateOAuthCommand can consume the same list.
 */
export const SHOPIFY_SCOPES_LIST = [
  'read_orders',
  'read_products',
  'read_customers',
  'write_script_tags',
  'write_pixels',
  'read_customer_events',
] as const;

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
  /**
   * OAuth connectors only. When true, the workspace user MUST supply per-brand Client ID /
   * Client Secret — env fallback (SHOPIFY_CLIENT_ID/SECRET etc.) is refused for this provider.
   * Requires `byoAppSetup` populated for the connect UI's setup panel.
   */
  byoAppRequired?: boolean;
  /** Declarative setup instructions rendered by the connect UI when `byoAppRequired`. */
  byoAppSetup?: ByoAppSetup;
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
    // Shopify Custom Apps are single-store: the workspace user MUST bring their own app's
    // Client ID / Client Secret. No env fallback (byoAppRequired), so both fields are REQUIRED.
    authFields: [
      { key: 'client_id',     label: 'Client ID',     type: 'text',     secret: false, optional: false, hint: 'From your Shopify Custom App API credentials.' },
      { key: 'client_secret', label: 'Client Secret', type: 'password', secret: true,  optional: false, hint: 'From your Shopify Custom App API credentials.' },
    ],
    byoAppRequired: true,
    byoAppSetup: {
      // Filled at request-build time from config.shopifyCallbackUrl — see marketplace tile builder.
      redirectUrl: '',
      scopes: SHOPIFY_SCOPES_LIST,
    },
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
      // site_url is non-secret but the WooCommerce repull client + pixel-install read the store
      // base URL from the bundle (woocommerce-client throws when it is absent), so it rides along.
      bundleNonSecretFields: ['site_url'],
      // webhook_secret is the per-connector HMAC signing key the WooCommerceWebhookStrategy verifies
      // against (base64 HMAC-SHA256). Brain MINTS it at connect-time (the merchant does not enter it)
      // and sets it on each WC webhook registration, so the inbound webhook lane is signed end-to-end.
      // (Closes the ULenin "bundle had no webhook_secret → webhook lane dead" gap — provisioned on the
      // generic credential-connect path via provisionGeneratedSecrets, same mechanism as Shiprocket.)
      generatedSecretFields: ['webhook_secret'],
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
    description: 'CoD + checkout conversion, abandoned-cart recovery & RTO-risk checkout signal (webhook-first).',
    authFields: [
      { key: 'appid', label: 'App ID', type: 'text', secret: false },
      { key: 'appsecret', label: 'App Secret', type: 'password', secret: true },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password', secret: true, optional: true },
    ],
    credentialConnect: {
      accountKeyField: 'appid',
      instanceColumn: 'gokwik_appid',
      // appid is the webhook routing id (resolve_gokwik_connector_by_merchant). Kept in the secret
      // bundle alongside {appsecret, webhook_secret} so the webhook receiver can verify the HMAC.
      bundleNonSecretFields: ['appid'],
      // #17: GENERALIZED webhook_secret provisioning (same SR-2 mechanism as Shiprocket). GoKwik's
      // webhook lane is HMAC-gated, fail-closed (GokwikWebhookStrategy reads webhook_secret from this
      // bundle). The merchant MAY paste their own GoKwik-configured secret via the optional webhook_secret
      // form field; when they leave it blank, Brain MINTS a high-entropy webhook_secret at connect so the
      // webhook receiver is never left without a key (previously the bundle held only {appid,appsecret}
      // → every GoKwik webhook 401'd). provisionGeneratedSecrets never overwrites a user-supplied value.
      generatedSecretFields: ['webhook_secret'],
      // The header GoKwik must send so the webhook resolves this tenant (resolve_gokwik_connector_by_
      // merchant). Its value is the accountKey = appid. Surfaced in the connect response next to the URL.
      webhookRoutingHeader: 'x-gokwik-appid',
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
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password', secret: true, optional: true },
    ],
    credentialConnect: {
      // merchant_id is routing-only — webhook lookup reads it from the column, never the bundle.
      accountKeyField: 'merchant_id',
      instanceColumn: 'shopflo_merchant_id',
      // webhook_secret is the per-connector HMAC signing key ShopfloWebhookStrategy verifies (fail-closed).
      // GENERALIZED provisioning (same SR-2 mechanism as GoKwik/Shiprocket): the merchant MAY paste their
      // own Shopflo-configured secret via the optional webhook_secret field; when blank, Brain MINTS a
      // high-entropy webhook_secret at connect so the HMAC lane is NEVER dead (no fail-closed gap).
      generatedSecretFields: ['webhook_secret'],
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
      // webhook_secret is NOT a form field — Shiprocket's tracking webhook sends a static X-Api-Key the
      // merchant configures in their dashboard. Brain MINTS it at connect-time, stores it in the bundle
      // (where ShiprocketWebhookStrategy timingSafe-verifies the X-Api-Key against it, fail-closed), and
      // returns it ONCE so the connect UI can show the merchant the URL + token to paste (SR-2).
      generatedSecretFields: ['webhook_secret'],
      // The header Shiprocket must send so the webhook resolves this tenant (resolve_shiprocket_connector
      // _by_channel). Its value is the accountKey = channel_id, else the email fallback.
      webhookRoutingHeader: 'x-shiprocket-channel-id',
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
      'Web session analytics via GA4 Data API — sessions, source/medium, revenue, conversions.',
    // GA4 connects through the OAuth2 authorization-code flow using Brain's registered Google app —
    // there is NO merchant-entered credential. authFields is therefore intentionally OMITTED so the
    // marketplace renders a pure OAuth "Connect" action, NOT a credential form. (Previously, a
    // field-less connector fell through to another connector's hardcoded fields — e.g. Razorpay's —
    // on the web; that fallback has been removed so a missing authFields can never leak another
    // connector's credential inputs.) Unlike Shopify/Meta/Google Ads, GA4 does not expose the
    // optional "bring your own OAuth app" pair, so it carries no authFields at all.
  },
] as const;
