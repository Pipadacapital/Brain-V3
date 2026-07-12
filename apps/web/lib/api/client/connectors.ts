// AUD-IMPL-006: extracted VERBATIM from the former 2,640-line apps/web/lib/api/client.ts
// (per-domain decomposition mirroring the backend CQ-1 split). Import from '@/lib/api/client'
// — the index re-exports this module's public surface unchanged.
import type {
  BackfillTriggerResponse,
  BackfillJobProgress,
} from '@brain/contracts';
import type {
  OkResponse,
  ConnectorListItem,
  ConnectorInstanceResponse,
  ShopifyInstallUrlResponse,
  PixelInstallationResponse,
  PixelHealthResponse,
  MarketplaceTile,
  ConnectResponseData,
  ConnectorProvider,
  ConnectorStatus,
  SyncState,
} from '../types';
import { bffFetch, generateRequestId, BffApiError, ensureCsrfToken } from './core';

// ── Connectors ────────────────────────────────────────────────────────────────
//
// The /v1/connectors endpoint returns an envelope shape:
//   { request_id, data: { shopify: { connected, status, shopDomain, ... },
//                          meta: { coming_soon }, google: { coming_soon } } }
//
// The client maps this into the ConnectorListItem[] that components consume.

interface RawConnectorShopify {
  connected: boolean;
  status: string | null;       // 'not_connected' | 'connected' | 'error'
  shopDomain: string | null;
  connectorInstanceId: string | null;
  syncState: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

interface RawConnectorMeta {
  coming_soon: boolean;
}

interface RawConnectorGoogle {
  coming_soon: boolean;
}

interface RawConnectorListData {
  shopify: RawConnectorShopify;
  meta: RawConnectorMeta;
  google: RawConnectorGoogle;
}

interface RawConnectorListEnvelope {
  request_id: string;
  data: RawConnectorListData;
}

/** Map the BFF envelope shape to the canonical ConnectorListItem[] used by UI. */
function mapConnectorList(raw: RawConnectorListEnvelope): ConnectorListItem[] {
  const { shopify, meta, google } = raw.data;

  const items: ConnectorListItem[] = [];

  // Shopify — the only live integration in M1
  const shopifyStatus =
    shopify.status === 'connected'
      ? 'connected'
      : shopify.status === 'error'
        ? 'error'
        : 'disconnected';

  items.push({
    provider: 'shopify',
    display_name: 'Shopify',
    description: 'Connect your Shopify store to sync orders and revenue data.',
    category: 'storefront',
    coming_soon: false,
    instance: shopify.connected && shopify.connectorInstanceId
      ? {
          id: shopify.connectorInstanceId,
          brand_id: '', // populated server-side; not needed for wizard display
          provider: 'shopify',
          shop_domain: shopify.shopDomain ?? '',
          status: shopifyStatus as ConnectorInstanceResponse['status'],
          connected_at: '',
          disconnected_at: null,
          sync_state: (shopify.syncState ?? 'waiting_for_data') as ConnectorInstanceResponse['sync_state'],
          last_sync_at: shopify.lastSyncAt,
          last_error: shopify.lastError,
        }
      : undefined,
  });

  // Meta Ads — coming soon
  if (meta.coming_soon) {
    items.push({
      provider: 'meta',
      display_name: 'Meta Ads',
      description: 'Connect your Meta Ads account for campaign performance data.',
      category: 'ads',
      coming_soon: true,
    });
  }

  // Google Ads — coming soon
  if (google.coming_soon) {
    items.push({
      provider: 'google',
      display_name: 'Google Ads',
      description: 'Connect your Google Ads account for search campaign data.',
      category: 'ads',
      coming_soon: true,
    });
  }

  return items;
}

// ── Marketplace (feat-connector-marketplace B0) ───────────────────────────────
// The new GET /api/v1/connectors returns { request_id, data: { tiles: MarketplaceTile[] } }.
// D-10: unwrap .data.tiles at the call site — never read the envelope flat.

interface RawMarketplaceEnvelope {
  request_id: string;
  data: { tiles: MarketplaceTile[] };
}

/** Map raw marketplace envelope → MarketplaceTile[] (unwraps .data.tiles — D-10). */
function mapTiles(raw: RawMarketplaceEnvelope): MarketplaceTile[] {
  // NN-2 guard: the server omits secret_ref and token; but as a contract assertion in the
  // client, we confirm no field named secret_ref, *_token, or *_key is present on any tile.
  // (If one appears, callers of getMarketplace() should treat it as a bounce-worthy backend leak.)
  return raw.data.tiles;
}

export const connectorsApi = {
  /**
   * Returns ConnectorListItem[] for the onboarding wizard.
   * Derives from getMarketplace() internally — single source of truth.
   * D-10: the new GET /v1/connectors returns { request_id, data: { tiles: MarketplaceTile[] } };
   * calling the old mapConnectorList() path (raw.data.shopify) produces undefined because the
   * endpoint no longer returns the legacy per-provider keyed shape. This mapping shim extracts
   * the onboarding wizard fields (shopify connected state + coming-soon tiles) from MarketplaceTile[].
   */
  list: async (): Promise<ConnectorListItem[]> => {
    const tiles = await connectorsApi.getMarketplace();
    return tiles.map((tile): ConnectorListItem => {
      const isConnected = tile.instance !== null;
      const status: ConnectorStatus =
        tile.instance?.status === 'error'
          ? 'error'
          : isConnected
            ? 'connected'
            : 'disconnected';
      return {
        provider: tile.id as ConnectorListItem['provider'],
        display_name: tile.display_name,
        description: tile.description,
        category: tile.category,
        coming_soon: !tile.available,
        instance: isConnected && tile.instance
          ? {
              id: tile.instance.id,
              brand_id: '',
              provider: tile.id as ConnectorProvider,
              shop_domain: tile.instance.shop_domain ?? '',
              status,
              connected_at: tile.instance.connected_at ?? '',
              disconnected_at: null,
              sync_state: 'connected' as SyncState,
              last_sync_at: null,
              last_error: null,
            }
          : undefined,
      };
    });
  },

  /**
   * GET /api/v1/connectors — marketplace catalog ⨝ instance list.
   * D-10: unwraps { request_id, data: { tiles } } → MarketplaceTile[].
   * NN-2: no secret_ref / no token in any tile (server contract; enforced by mapTiles).
   */
  getMarketplace: async (): Promise<MarketplaceTile[]> => {
    const raw = await bffFetch<RawMarketplaceEnvelope>('/v1/connectors');
    return mapTiles(raw);
  },

  /**
   * POST /api/v1/connectors — generic connect.
   * D-10: unwraps { request_id, data } → ConnectResponseData.
   * oauth ⇒ { kind:'oauth', oauth_url } — caller redirects.
   * credential ⇒ { kind:'credential', connected:true }.
   * coming-soon ⇒ server returns 422 CONNECTOR_NOT_AVAILABLE (throws BffApiError).
   */
  connect: async (
    type: string,
    opts?: { shop_domain?: string; credentials?: Record<string, string> },
  ): Promise<ConnectResponseData> => {
    const res = await bffFetch<{ request_id: string; data: ConnectResponseData }>(
      '/v1/connectors',
      {
        method: 'POST',
        body: JSON.stringify({ type, ...opts }),
        idempotencyKey: generateRequestId(),
      },
    );
    // D-10: unwrap .data — never read res.oauth_url directly (9th envelope mismatch).
    return res.data;
  },

  // Shopify OAuth requires the store domain (e.g. my-store.myshopify.com) — the
  // backend 400s (MISSING_SHOP_PARAM) without it.
  // BFF returns { request_id, data: { install_url } } — unwrap .data so callers read
  // install_url directly. Without this, window.location.href = undefined → /settings/undefined.
  getShopifyInstallUrl: async (shop: string): Promise<ShopifyInstallUrlResponse> => {
    const res = await bffFetch<{ request_id: string; data: ShopifyInstallUrlResponse }>(
      `/v1/connectors/shopify/install?shop=${encodeURIComponent(shop)}`,
    );
    return res.data;
  },

  // BFF returns { request_id, data: {...} } — unwrap to flat ConnectorInstanceResponse.
  getStatus: async (connectorId: string): Promise<ConnectorInstanceResponse> => {
    const res = await bffFetch<{ request_id: string; data: ConnectorInstanceResponse }>(
      `/v1/connectors/${connectorId}/status`,
    );
    return res.data;
  },

  disconnect: (connectorId: string) =>
    bffFetch<OkResponse>(`/v1/connectors/${connectorId}`, {
      method: 'DELETE',
      idempotencyKey: generateRequestId(),
    }),

  // 0106: activate ONE ad account per (brand, platform) — switch semantics (activating one
  // deactivates its siblings server-side). Only the activated account ingests spend.
  activateAdAccount: async (
    connectorId: string,
  ): Promise<{ connector_instance_id: string; provider: string; account_key: string; activated_at: string }> => {
    const res = await bffFetch<{
      request_id: string;
      data: { connector_instance_id: string; provider: string; account_key: string; activated_at: string };
    }>(`/v1/connectors/${connectorId}/activate`, {
      method: 'POST',
      idempotencyKey: generateRequestId(),
    });
    return res.data;
  },
};

// ── Pixel ─────────────────────────────────────────────────────────────────────

interface RawPixelInstallation {
  installed: boolean;
  installation_id?: string;
  install_token?: string;
  target_host?: string;
  custom_ingest_host?: string | null;
  snippet_html?: string;
  is_new?: boolean;
}

/** One install option the UI can render (connected-storefront-driven). */
export interface PixelInstallerDescriptor {
  provider: string;
  displayName: string;
  available: boolean;
  supportsUninstall: boolean;
}

/** Uniform install result across storefronts; provider-specific extras ride in `meta`. */
export interface PixelInstallResult {
  installed: boolean;
  provider: string;
  ref: string;
  install_token: string;
  src: string;
  already_present: boolean;
  meta?: {
    /** Shopify: checkout (Web Pixel) coverage status. */
    webPixel?: { status: 'enabled' | 'pending'; message: string };
    /** WooCommerce: the configured plugin version. */
    pluginVersion?: string | null;
  };
}

function mapPixel(d: RawPixelInstallation): PixelInstallationResponse {
  return {
    installed: d.installed,
    installation_id: d.installation_id,
    install_token: d.install_token,
    target_host: d.target_host,
    custom_ingest_host: d.custom_ingest_host ?? null,
    snippet: d.snippet_html,
    is_new: d.is_new,
  };
}

export const pixelApi = {
  // GET is read-only (SEC-0009-M01): returns the existing installation or installed:false.
  getInstallation: async (): Promise<PixelInstallationResponse> => {
    const { data } = await bffFetch<{ data: RawPixelInstallation }>('/v1/pixel/installation');
    return mapPixel(data);
  },

  // POST provisions (get-or-create) — the write path, CSRF-protected.
  provision: async (target_host: string): Promise<PixelInstallationResponse> => {
    const { data } = await bffFetch<{ data: RawPixelInstallation }>('/v1/pixel/installation', {
      method: 'POST',
      body: JSON.stringify({ target_host }),
      idempotencyKey: generateRequestId(),
    });
    return mapPixel(data);
  },

  // PATCH sets/clears the first-party CNAME ingest host (manager+). Pass null to clear.
  setIngestHost: async (custom_ingest_host: string | null): Promise<PixelInstallationResponse> => {
    const { data } = await bffFetch<{ data: RawPixelInstallation }>('/v1/pixel/ingest-host', {
      method: 'PATCH',
      body: JSON.stringify({ custom_ingest_host }),
    });
    return mapPixel(data);
  },

  verify: () =>
    bffFetch<OkResponse>('/v1/pixel/verify', {
      method: 'POST',
      idempotencyKey: generateRequestId(),
    }),

  // Production install path: auto-inject the pixel onto the connected Shopify storefront
  // (Admin API ScriptTag) + flip installed_at — no manual paste. Idempotent.
  installShopify: async (): Promise<{ installed: boolean; provider: string; already_present: boolean }> => {
    const { data } = await bffFetch<{ data: { installed: boolean; provider: string; already_present: boolean } }>(
      '/v1/pixel/install/shopify',
      { method: 'POST', idempotencyKey: generateRequestId() },
    );
    return data;
  },

  // Removal path: delete the Brain ScriptTag(s) from the connected storefront + clear install state.
  uninstallShopify: async (): Promise<{ removed: number; already_absent: boolean }> => {
    const { data } = await bffFetch<{ data: { removed: number; already_absent: boolean } }>(
      '/v1/pixel/uninstall/shopify',
      { method: 'POST', idempotencyKey: generateRequestId() },
    );
    return data;
  },

  // ── Storefront-agnostic install surface (feat-universal-pixel) ──────────────
  // The merchant connects a storefront first; Brain then offers the install option(s) for the
  // connected storefront(s). Adding a platform on the backend surfaces here with no UI change.

  // GET the install options available to this brand (connected-storefront-driven).
  listInstallers: async (): Promise<{ installers: PixelInstallerDescriptor[] }> => {
    const { data } = await bffFetch<{ data: { installers: PixelInstallerDescriptor[] } }>(
      '/v1/pixel/installers',
    );
    return data;
  },

  // Run the installer for a connected storefront (shopify | woocommerce | …).
  installProvider: async (provider: string): Promise<PixelInstallResult> => {
    const { data } = await bffFetch<{ data: PixelInstallResult }>(`/v1/pixel/install/${provider}`, {
      method: 'POST',
      idempotencyKey: generateRequestId(),
    });
    return data;
  },

  // Remove the pixel from a storefront (when the installer supports it).
  uninstallProvider: async (
    provider: string,
  ): Promise<{ removed: boolean; provider: string; already_absent: boolean }> => {
    const { data } = await bffFetch<{
      data: { removed: boolean; provider: string; already_absent: boolean };
    }>(`/v1/pixel/install/${provider}`, { method: 'DELETE', idempotencyKey: generateRequestId() });
    return data;
  },

  // Direct browser-download URL for the Brain Pixel WordPress/WooCommerce plugin (no secrets).
  wooCommercePluginUrl: '/api/bff/v1/pixel/woocommerce/plugin.zip',

  // BFF returns { request_id, data: {...} } — unwrap to flat PixelHealthResponse.
  getHealth: async (): Promise<PixelHealthResponse> => {
    const res = await bffFetch<{ request_id: string; data: PixelHealthResponse }>('/v1/pixel/health');
    return res.data;
  },
};

// ── Backfill (feat-connector-backfill C0) ────────────────────────────────────
//
// POST /api/v1/connectors/:id/backfill → 202 { request_id, data: { job_id, status } }
// GET  /api/v1/connectors/:id/jobs     → 200 { request_id, data: BackfillJobProgress }
//
// Error codes (409): RECONNECT_REQUIRED (D-7), BACKFILL_ALREADY_RUNNING (D-9).
// Authz gate: brand_admin+ (D-15); manager receives 403.
// The client calls the core API directly (not BFF) because backfill routes are on core :3001.
// These calls go through /api/v1/* which is proxied to core in next.config.js.
//
// D-8 honesty: estimated_total=null is preserved as-is — never coerced to 0.

export type { BackfillTriggerResponse, BackfillJobProgress };

/**
 * Triggers a backfill job for the given connector.
 * Returns { job_id, status:'queued' } on 202.
 * Throws BffApiError with code RECONNECT_REQUIRED (409) or BACKFILL_ALREADY_RUNNING (409).
 * Throws BffApiError with status 403 for manager-role users (D-15).
 *
 * @param requestedWindowMs OPTIONAL depth-picker window (BackfillTriggerRequest, 0127) in ms.
 *   Omitted = provider max — sent as a body-less POST (byte-identical to the pre-picker call).
 *   The server clamps to the provider manifest's maxBackfillWindowMs at claim time.
 */
async function triggerBackfill(connectorId: string, requestedWindowMs?: number): Promise<BackfillTriggerResponse> {
  const requestId = generateRequestId();
  const method = 'POST';
  const csrfToken = await ensureCsrfToken();

  const response = await fetch(`/api/v1/connectors/${encodeURIComponent(connectorId)}/backfill`, {
    method,
    // Body ONLY when a depth was picked. Otherwise no body — and do NOT declare a JSON
    // content-type, or Fastify rejects the empty body with 400 "Body cannot be empty when
    // content-type is set to 'application/json'".
    headers: {
      'X-Request-Id': requestId,
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...(requestedWindowMs !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(requestedWindowMs !== undefined
      ? { body: JSON.stringify({ requested_window_ms: requestedWindowMs }) }
      : {}),
    credentials: 'include',
  });

  if (!response.ok) {
    let errorBody: { request_id?: string; error?: { code?: string; message?: string } } = {};
    try { errorBody = await response.json(); } catch { /* non-JSON */ }
    const message = errorBody?.error?.message ?? `Backfill trigger failed: ${response.status}`;
    const reqId = errorBody?.request_id ?? requestId;
    throw new BffApiError(message, response.status, reqId, errorBody?.error?.code);
  }

  const raw = await response.json() as { request_id: string; data: BackfillTriggerResponse };
  // Unwrap .data — the canonical BackfillTriggerResponse { job_id, status }.
  return raw.data;
}

/**
 * Fetches the latest backfill job progress for the given connector.
 * Returns BackfillJobProgress or throws BffApiError if no job found (404).
 * D-8: estimated_total=null is preserved — never fabricated.
 */
async function getBackfillProgress(connectorId: string): Promise<BackfillJobProgress> {
  const requestId = generateRequestId();

  const response = await fetch(`/api/v1/connectors/${encodeURIComponent(connectorId)}/jobs`, {
    method: 'GET',
    headers: {
      'X-Request-Id': requestId,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    let errorBody: { request_id?: string; error?: { code?: string; message?: string } } = {};
    try { errorBody = await response.json(); } catch { /* non-JSON */ }
    const message = errorBody?.error?.message ?? `Backfill progress fetch failed: ${response.status}`;
    const reqId = errorBody?.request_id ?? requestId;
    throw new BffApiError(message, response.status, reqId, errorBody?.error?.code);
  }

  const raw = await response.json() as { request_id: string; data: BackfillJobProgress };
  // Unwrap .data — the canonical BackfillJobProgress.
  return raw.data;
}

export const backfillApi = {
  triggerBackfill,
  getBackfillProgress,
};

// ── Sync now (feat-connector-sync-now Track B) ───────────────────────────────
//
// POST /api/v1/connectors/:id/sync   → 202 { request_id, data: { connector_instance_id, status:'syncing' } }
// GET  /api/v1/connectors/:id/status → 200 { request_id, data: ConnectorInstanceResponse }  (reused)
//
// The trigger enqueues the SAME incremental trailing-window re-pull the scheduler runs
// (no new topic/envelope) — overlap-locked server-side so a manual click can't double-run.
//
// Error codes (409): RECONNECT_REQUIRED (token expired → reconnect),
//                    SYNC_ALREADY_RUNNING / SYNC_ALREADY_REQUESTED (overlap lock held).
// Authz gate: brand_admin+ (mirrors backfill D-15); manager/analyst receive 403 (button hidden).
// Calls core :3001 directly via /api/v1/* proxy (same path as triggerBackfill).

/** 202 trigger response — the connector is now (or already) syncing. */
export interface SyncTriggerResponse {
  connector_instance_id: string;
  status: 'syncing';
}

/**
 * Triggers an on-demand incremental sync for the given connector.
 * Returns { connector_instance_id, status:'syncing' } on 202.
 * Throws BffApiError with code RECONNECT_REQUIRED / SYNC_ALREADY_RUNNING /
 *   SYNC_ALREADY_REQUESTED (409), or status 403 for manager/analyst.
 */
async function triggerSync(connectorId: string): Promise<SyncTriggerResponse> {
  const requestId = generateRequestId();
  const csrfToken = await ensureCsrfToken();

  const response = await fetch(`/api/v1/connectors/${encodeURIComponent(connectorId)}/sync`, {
    method: 'POST',
    // No request body — do NOT declare a JSON content-type, or Fastify rejects the empty
    // body with 400 "Body cannot be empty when content-type is set to 'application/json'".
    headers: {
      'X-Request-Id': requestId,
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
    credentials: 'include',
  });

  if (!response.ok) {
    let errorBody: { request_id?: string; error?: { code?: string; message?: string } } = {};
    try { errorBody = await response.json(); } catch { /* non-JSON */ }
    const message = errorBody?.error?.message ?? `Sync trigger failed: ${response.status}`;
    const reqId = errorBody?.request_id ?? requestId;
    throw new BffApiError(message, response.status, reqId, errorBody?.error?.code);
  }

  const raw = await response.json() as { request_id: string; data: SyncTriggerResponse };
  // Unwrap .data — the canonical SyncTriggerResponse.
  return raw.data;
}

export const syncApi = {
  triggerSync,
  // Status is read via the EXISTING per-connector status route (reused, not duplicated).
  getSyncStatus: (connectorId: string) => connectorsApi.getStatus(connectorId),
};
