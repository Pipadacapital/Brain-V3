/**
 * connector.api.v1 — Zod contracts for Connector API endpoints.
 *
 * GET    /api/v1/connectors
 * GET    /api/v1/connectors/shopify/install
 * GET    /api/v1/connectors/shopify/callback
 * GET    /api/v1/connectors/:id/status
 * DELETE /api/v1/connectors/:id
 *
 * INVARIANTS:
 *  - NN-2: ConnectorInstance schema has secret_ref ONLY — NO token/ciphertext field.
 *    Semgrep scans this file for any field named *_token, *_secret, *_key.
 *  - HMAC validation is the first operation in the Shopify callback handler (NN-4).
 *  - Meta/Google = zero backend (coming_soon: true flag only).
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

// ── List Connectors ───────────────────────────────────────────────────────────

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

export const ConnectorSyncStatusSchema = z.object({
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
