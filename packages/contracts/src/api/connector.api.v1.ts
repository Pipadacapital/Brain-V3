/**
 * connector.api.v1 — Zod contracts for Connector API endpoints.
 *
 * Endpoints (frozen A0 — feat-connector-marketplace):
 *   GET    /api/v1/connectors             ← marketplace list (catalog ⨝ instance)
 *   POST   /api/v1/connectors             ← generic connect (oauth | credential)
 *   GET    /api/v1/oauth/callback/:type   ← generic OAuth callback (brand_id from state ONLY — D-1)
 *   DELETE /api/v1/connectors/:id         ← disconnect
 *   POST   /api/v1/connectors/:id/backfill← backfill gate (brand_admin+, 501 stub — D-9)
 *
 * Legacy Shopify-specific endpoints (kept for back-compat during transition):
 *   GET    /api/v1/connectors/shopify/install
 *   GET    /api/v1/connectors/shopify/callback   ← DELETED; replaced by generic callback
 *   GET    /api/v1/connectors/:id/status
 *
 * INVARIANTS:
 *  - NN-2: ConnectorInstance schema has secret_ref ONLY — NO token/ciphertext field.
 *    Semgrep scans this file for any field named *_token, *_secret, *_key.
 *  - HMAC validation is the first operation in the Shopify callback handler (NN-4).
 *  - D-1: brand_id derived from signed state ONLY, never from body/query/header.
 *  - D-10: all new responses carry { request_id, data } envelope.
 */
import { z } from 'zod';

// ── Connector Instance ────────────────────────────────────────────────────────
// NN-2: NO oauth_token, NO *_ciphertext, NO *_secret, NO *_key column.
// The only credential reference is secret_ref (AWS Secrets Manager ARN).

export const ConnectorInstanceSchema = z.object({
  id: z.string().uuid(),
  brand_id: z.string().uuid(),
  provider: z.enum(['shopify']),
  shop_domain: z.string().max(255),
  /** AWS Secrets Manager ARN — the ONLY credential reference (NN-2 / I-S09). */
  secret_ref: z.string().min(1).max(2048),
  status: z.enum(['connected', 'disconnected', 'error']),
  connected_at: z.string().datetime({ offset: true }),
  disconnected_at: z.string().datetime({ offset: true }).nullable(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});
export type ConnectorInstance = z.infer<typeof ConnectorInstanceSchema>;

// ── Connector List Entry ──────────────────────────────────────────────────────
// Includes coming_soon connectors (Meta/Google = no backend, UI stub only).

export const ConnectorListEntrySchema = z.object({
  provider: z.string(),
  display_name: z.string(),
  coming_soon: z.boolean().default(false),
  connected: z.boolean().default(false),
  connector_id: z.string().uuid().nullable(),
  status: z.enum(['connected', 'disconnected', 'error']).nullable(),
});
export type ConnectorListEntry = z.infer<typeof ConnectorListEntrySchema>;

// ── List Connectors (legacy) ──────────────────────────────────────────────────

export const ListConnectorsResponseSchema = z.object({
  request_id: z.string().uuid(),
  connectors: z.array(ConnectorListEntrySchema),
});
export type ListConnectorsResponse = z.infer<typeof ListConnectorsResponseSchema>;

// ── Shopify Install ───────────────────────────────────────────────────────────

export const ShopifyInstallQuerySchema = z.object({
  shop: z
    .string()
    .regex(/^[a-zA-Z0-9-]+\.myshopify\.com$/, 'shop must be *.myshopify.com format'),
  brand_id: z.string().uuid(),
});
export type ShopifyInstallQuery = z.infer<typeof ShopifyInstallQuerySchema>;

export const ShopifyInstallResponseSchema = z.object({
  request_id: z.string().uuid(),
  install_url: z.string().url(),
});
export type ShopifyInstallResponse = z.infer<typeof ShopifyInstallResponseSchema>;

// ── Shopify Callback ──────────────────────────────────────────────────────────
// Public endpoint — HMAC validation is the first operation (NN-4).

export const ShopifyCallbackQuerySchema = z.object({
  code: z.string().min(1),
  hmac: z.string().min(1),
  shop: z
    .string()
    .regex(/^[a-zA-Z0-9-]+\.myshopify\.com$/, 'shop must be *.myshopify.com format'),
  state: z.string().min(1),
  timestamp: z.string().min(1),
});
export type ShopifyCallbackQuery = z.infer<typeof ShopifyCallbackQuerySchema>;

// ── Connector Status ──────────────────────────────────────────────────────────

const ConnectorSyncStatusSchema = z.object({
  state: z.enum(['connected', 'syncing', 'waiting_for_data', 'error']),
  last_sync_at: z.string().datetime({ offset: true }).nullable(),
  last_error: z.string().nullable(),
});

export const ConnectorStatusResponseSchema = z.object({
  request_id: z.string().uuid(),
  connector: ConnectorInstanceSchema,
  sync_status: ConnectorSyncStatusSchema.nullable(),
});
export type ConnectorStatusResponse = z.infer<typeof ConnectorStatusResponseSchema>;

// ── On-demand "Sync now" trigger (feat-connector-sync-now) ────────────────────
// POST /api/v1/connectors/:id/sync → 202 { request_id, data: SyncTriggerData }.
// Enqueues an INCREMENTAL trailing-window re-pull (NOT a full backfill); the
// in-worker claimer dispatches the SAME run() the scheduler invokes (same code path).
// brand_admin+ only; brand_id from session, never the body (MT-1). Overlap-locked +
// spam-safe via the sentinel-row dedup + run()'s own FOR UPDATE SKIP LOCKED.
// Error codes: CONNECTOR_NOT_FOUND (404), RECONNECT_REQUIRED / SYNC_ALREADY_RUNNING /
// SYNC_ALREADY_REQUESTED / CONNECTOR_NOT_SYNCABLE (409). NO secret_ref / token (I-S09).

export const SyncTriggerDataSchema = z.object({
  connector_instance_id: z.string().uuid(),
  status: z.literal('syncing'),
  requested_at: z.string().datetime({ offset: true }),
});
export type SyncTriggerData = z.infer<typeof SyncTriggerDataSchema>;

export const SyncTriggerResponseSchema = z.object({
  request_id: z.string(),
  data: SyncTriggerDataSchema,
});
export type SyncTriggerResponse = z.infer<typeof SyncTriggerResponseSchema>;

// ════════════════════════════════════════════════════════════════════════════════
// MARKETPLACE CONTRACT — A0 FREEZE (feat-connector-marketplace)
// Track B consumes .data from these shapes exactly.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * ConnectableConnectorType — only connectors that are both available AND have a
 * non-coming_soon connectMethod in M1 may appear here (ADR-CM-2).
 * Coming-soon types are structurally excluded from the connectable union (Hon-C3).
 */
export const ConnectableConnectorType = z.enum(['shopify']);
export type ConnectableConnectorType = z.infer<typeof ConnectableConnectorType>;

/** ConnectorTypeSchema — any catalog id (for catalog rendering, including coming-soon). */
export const ConnectorTypeSchema = z.string();
export type ConnectorTypeSchema = z.infer<typeof ConnectorTypeSchema>;

// ── 7-state health + 3-state safety (ADR-CM-5) ───────────────────────────────

export const HealthStateSchema = z.enum([
  'Healthy',
  'Delayed',
  'Failed',
  'Disconnected',
  'RateLimited',
  'TokenExpired',
  'Disabled',
]);
export type HealthState = z.infer<typeof HealthStateSchema>;

export const SafetyRatingSchema = z.enum(['safe', 'degraded', 'blocked']);
export type SafetyRating = z.infer<typeof SafetyRatingSchema>;

// ── Marketplace tile (catalog ⨝ connector_instance) ──────────────────────────
// NN-2: NO secret_ref, NO token in this response (success criterion #4).
// D-10: wrapped in { request_id, data } at the response level.

/** One connected account for a provider tile (Gap B multi-account). NN-2: NO secret_ref/token. */
export const MarketplaceTileInstanceSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['connected', 'disconnected', 'error']),
  health_state: HealthStateSchema,
  safety_rating: SafetyRatingSchema,
  shop_domain: z.string().nullable(),
  connected_at: z.string().datetime({ offset: true }).nullable(),
  /** Per-account key (Gap B, 0092) — e.g. a Meta act_<id>. */
  account_key: z.string().optional(),
  /** Human name for the account (e.g. Meta ad-account name); null/absent ⇒ show account_key. */
  account_label: z.string().nullable().optional(),
  /** Ad-account activation (0106). When this account was chosen to ingest; null ⇒ not chosen. */
  activated_at: z.string().datetime({ offset: true }).nullable().optional(),
  /** This is the active (ingesting) account. Always true for non-ad providers. */
  is_active: z.boolean().optional(),
  /** Ad platform whose account has not been picked yet → UI prompts for a selection. */
  requires_activation: z.boolean().optional(),
});
export type MarketplaceTileInstance = z.infer<typeof MarketplaceTileInstanceSchema>;

export const MarketplaceTileSchema = z.object({
  id: z.string(),
  category: z.enum(['storefront', 'ads', 'payments', 'logistics', 'messaging', 'crm', 'analytics']),
  display_name: z.string(),
  description: z.string(),
  connect_method: z.enum(['oauth', 'credential', 'coming_soon']),
  /** false ⇒ tile disabled, coming-soon, un-connectable (ADR-CM-2). */
  available: z.boolean(),
  /**
   * Present only when this brand has a connector_instance for this provider.
   * First active account (back-compat single-account UI). NN-2: NO secret_ref, NO token here.
   */
  instance: MarketplaceTileInstanceSchema.nullable(),
  /** ALL active accounts for this provider (Gap B multi-account). Empty when none connected. */
  instances: z.array(MarketplaceTileInstanceSchema).optional(),
});
export type MarketplaceTile = z.infer<typeof MarketplaceTileSchema>;

// ── Ad-account activation (0106) ─────────────────────────────────────────────
export const ActivateAdAccountResponseSchema = z.object({
  request_id: z.string(),
  data: z.object({
    connector_instance_id: z.string().uuid(),
    provider: z.string(),
    account_key: z.string(),
    activated_at: z.string().datetime({ offset: true }),
  }),
});
export type ActivateAdAccountResponse = z.infer<typeof ActivateAdAccountResponseSchema>;

export const MarketplaceListResponseSchema = z.object({
  request_id: z.string(),
  data: z.object({ tiles: z.array(MarketplaceTileSchema) }),
});
export type MarketplaceListResponse = z.infer<typeof MarketplaceListResponseSchema>;

// ── Generic connect request / response (ADR-CM-2) ────────────────────────────

export const ConnectRequestSchema = z.object({
  /** Validated against catalog server-side. Unknown type ⇒ 400. Coming-soon ⇒ 422. */
  type: z.string(),
  /**
   * Shopify store domain. On the OAuth fallback it may ride top-level; on the generic
   * per-brand credential connect it rides in `credentials.shop_domain` (catalog authFields).
   */
  shop_domain: z.string().optional(),
  /**
   * For credential connectors. Shopify (generic per-brand connect, 2026-07-12) requires
   * { shop_domain, client_id, client_secret } — the custom app created in the brand's own
   * Shopify admin; the server does the client-credentials exchange (no browser redirect).
   */
  credentials: z.record(z.string()).optional(),
});
export type ConnectRequest = z.infer<typeof ConnectRequestSchema>;

/**
 * Per-tenant inbound-webhook setup surfaced on a credential connect.
 *  - `api_key` is present ONLY when Brain minted a webhook token this connect (SR-2 —
 *    Shiprocket/GoKwik/Shopflo/WooCommerce); it is shown once (write-only thereafter).
 *  - Shopify registers its webhooks automatically via the Admin API, so it returns the
 *    delivery URL with api_key: null (informational — nothing to paste).
 */
export const ConnectWebhookSetupSchema = z.object({
  url: z.string().url(),
  api_key: z.string().nullable(),
  routing_header: z.object({ name: z.string(), value: z.string() }).nullable(),
});
export type ConnectWebhookSetup = z.infer<typeof ConnectWebhookSetupSchema>;

export const ConnectResponseSchema = z.object({
  request_id: z.string(),
  data: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('oauth'), oauth_url: z.string().url() }),
    z.object({
      kind: z.literal('credential'),
      connected: z.literal(true),
      connector_instance_id: z.string().uuid().optional(),
      /** Present for webhook connectors (see ConnectWebhookSetupSchema). */
      webhook: ConnectWebhookSetupSchema.optional(),
    }),
  ]),
});
export type ConnectResponse = z.infer<typeof ConnectResponseSchema>;

// coming_soon ⇒ 422 { request_id, error: { code: 'CONNECTOR_NOT_AVAILABLE' } }
// Not modelled in a success schema (it's an error response, not in the data union).
//
// Shopify generic per-brand connect error codes (POST /api/v1/connectors, type='shopify'):
//   400 INVALID_SHOP_DOMAIN            — shop_domain does not normalize to *.myshopify.com
//   400 MISSING_SHOPIFY_CREDENTIALS    — no client_id/client_secret and no env app fallback
//   422 SHOPIFY_CREDENTIALS_INVALID    — Shopify rejected the client-credentials exchange /
//                                        the issued token failed the shop.json verification
//   409 STOREFRONT_ALREADY_CONNECTED   — the brand already has a different storefront connected
