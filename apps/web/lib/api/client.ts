/**
 * BFF API client — the web app talks ONLY to the frontend-api BFF.
 * Never the DB, never StarRocks, never Postgres directly.
 *
 * All calls go to /api/bff/* which maps to the frontend-api module in apps/core.
 * The BFF exchanges the httpOnly cookie for a short-lived access token on every call.
 *
 * Correlation ID (X-Request-Id) is forwarded on every request so the backend
 * can include it in the error response for UI display.
 */

import type {
  RegisterRequest,
  RegisterResponse,
  LoginRequest,
  LoginResponse,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  VerifyEmailRequest,
  OkResponse,
  CurrentUserResponse,
  CreateWorkspaceRequest,
  WorkspaceResponse,
  WorkspaceListResponse,
  SessionRefreshResponse,
  CreateBrandRequest,
  BrandResponse,
  MemberResponse,
  InviteMemberRequest,
  UpdateMemberRoleRequest,
  ConnectorListItem,
  ConnectorInstanceResponse,
  ShopifyInstallUrlResponse,
  PixelInstallationResponse,
  PixelHealthResponse,
  DashboardBrandSummaryResponse,
  DashboardConnectionStatusResponse,
  DashboardDataStatusResponse,
  DashboardOnboardingResponse,
  PaginatedResponse,
  AcceptInviteRequest,
  SetOrgRequest,
  SetOrgResponse,
  OnboardingAdvanceRequest,
  OnboardingAdvanceResponse,
} from './types';

/** All BFF routes proxied through Next.js API routes → frontend-api module */
const BFF_BASE = '/api/bff';

const CSRF_COOKIE = 'brain_csrf';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function generateRequestId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/** Read a non-httpOnly cookie value by name (browser only). */
function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/**
 * Double-submit CSRF token. The server (GET /api/v1/bff/csrf) sets a JS-readable
 * `brain_csrf` cookie; we echo its value in the `x-csrf-token` header on every
 * state-changing request. Bootstraps the cookie on first use.
 */
async function ensureCsrfToken(): Promise<string | undefined> {
  if (typeof document === 'undefined') return undefined; // SSR — no cookie jar
  let token = readCookie(CSRF_COOKIE);
  if (!token) {
    await fetch(`${BFF_BASE}/v1/bff/csrf`, { credentials: 'include' });
    token = readCookie(CSRF_COOKIE);
  }
  return token;
}

/**
 * Core fetch wrapper — adds correlation headers, handles error envelope,
 * surfaces request_id on errors for UI display.
 */
async function bffFetch<T>(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const requestId = generateRequestId();
  const method = (options.method ?? 'GET').toUpperCase();
  const isMutation = MUTATING.has(method);

  const buildHeaders = (csrfToken: string | undefined): Record<string, string> => ({
    // Only declare a JSON content-type when there is actually a body. A POST with
    // `Content-Type: application/json` and an empty body is rejected by Fastify's
    // body parser with a 400 (e.g. logout, session/refresh — no-body mutations).
    ...(options.body != null ? { 'Content-Type': 'application/json' } : {}),
    'X-Request-Id': requestId,
    ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    ...(options.idempotencyKey
      ? { 'Idempotency-Key': options.idempotencyKey }
      : {}),
    ...(options.headers as Record<string, string> | undefined),
  });

  // Double-submit CSRF token on state-changing requests (server enforces it for
  // cookie-authenticated mutations). Exempt routes (login/register) ignore it.
  const csrfToken = isMutation ? await ensureCsrfToken() : undefined;

  let response = await fetch(`${BFF_BASE}${path}`, {
    ...options,
    headers: buildHeaders(csrfToken),
    credentials: 'include', // send httpOnly cookie
  });

  // The CSRF token is bound to the session (server-side). A token issued before
  // login (or before a session rotation) won't match — force-refresh a fresh,
  // session-bound token and retry the mutation ONCE.
  if (response.status === 403 && isMutation) {
    const peeked = await response
      .clone()
      .json()
      .catch(() => ({}) as { error?: { code?: string } });
    if (peeked?.error?.code === 'CSRF_MISMATCH') {
      await fetch(`${BFF_BASE}/v1/bff/csrf`, { credentials: 'include' });
      const fresh = readCookie(CSRF_COOKIE);
      response = await fetch(`${BFF_BASE}${path}`, {
        ...options,
        headers: buildHeaders(fresh),
        credentials: 'include',
      });
    }
  }

  if (!response.ok) {
    let errorBody: { request_id?: string; error?: { code?: string; message?: string } } = {};
    try {
      errorBody = await response.json();
    } catch {
      // non-JSON error body
    }
    // Session expired or invalid → log out and redirect to /login. The browser holds
    // only the (httpOnly) access cookie and no refresh token, so an expired access
    // token cannot be refreshed — the only correct outcome is to send the user back to
    // login. Excludes the login route's own bad-credentials 401 (INVALID_CREDENTIALS),
    // which must surface its error instead of redirecting.
    if (
      response.status === 401 &&
      errorBody?.error?.code !== 'INVALID_CREDENTIALS' &&
      typeof window !== 'undefined' &&
      window.location.pathname !== '/login'
    ) {
      window.location.href = '/login';
    }
    const message = errorBody?.error?.message ?? `Request failed: ${response.status}`;
    const reqId = errorBody?.request_id ?? requestId;
    const err = new BffApiError(message, response.status, reqId, errorBody?.error?.code);
    throw err;
  }

  if (response.status === 204) {
    return undefined as unknown as T;
  }

  return response.json() as Promise<T>;
}

export class BffApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'BffApiError';
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  register: (body: RegisterRequest) =>
    bffFetch<RegisterResponse>('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  verifyEmail: (body: VerifyEmailRequest) =>
    bffFetch<OkResponse>('/v1/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  // Login goes through the BFF session route, which sets the httpOnly `brain_session`
  // cookie (the raw /v1/auth/login route returns the token in the body and sets no
  // cookie — unusable from the browser). All subsequent requests authenticate via
  // that cookie (bridged to a Bearer header server-side).
  login: async (body: LoginRequest): Promise<LoginResponse> => {
    const res = await bffFetch<LoginResponse>('/v1/bff/session', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    // Refresh the CSRF token now that a session exists — the token is bound to the
    // session, so a pre-login token would be rejected on the first authenticated
    // mutation. Re-issuing here gives a session-bound token up front (no 403/retry).
    if (typeof document !== 'undefined') {
      await fetch(`${BFF_BASE}/v1/bff/csrf`, { credentials: 'include' });
    }
    return res;
  },

  logout: () =>
    bffFetch<OkResponse>('/v1/auth/logout', {
      method: 'POST',
      idempotencyKey: generateRequestId(),
    }),

  forgotPassword: (body: ForgotPasswordRequest) =>
    bffFetch<OkResponse>('/v1/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  resetPassword: (body: ResetPasswordRequest) =>
    bffFetch<OkResponse>('/v1/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  me: () => bffFetch<CurrentUserResponse>('/v1/auth/me'),
};

// ── Session ───────────────────────────────────────────────────────────────────

export const sessionApi = {
  refresh: () =>
    bffFetch<SessionRefreshResponse>('/v1/bff/session/refresh', {
      method: 'POST',
      idempotencyKey: generateRequestId(),
    }),

  /** Switch active org context. Re-mints the session cookie and returns onboarding_status. */
  setOrg: (body: SetOrgRequest) =>
    bffFetch<SetOrgResponse>('/v1/bff/session/set-org', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  /** Advance the wizard onboarding_status (forward-only). */
  advanceOnboarding: (body: OnboardingAdvanceRequest) =>
    bffFetch<OnboardingAdvanceResponse>('/v1/bff/session/onboarding/advance', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),
};

// ── Workspace ─────────────────────────────────────────────────────────────────

export const workspaceApi = {
  create: (body: CreateWorkspaceRequest) =>
    bffFetch<WorkspaceResponse>('/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  get: (id: string) => bffFetch<WorkspaceResponse>(`/v1/workspaces/${id}`),

  list: (cursor?: string) =>
    bffFetch<WorkspaceListResponse>(
      `/v1/workspaces${cursor ? `?cursor=${cursor}` : ''}`,
    ),
};

// ── Brand ─────────────────────────────────────────────────────────────────────

export const brandApi = {
  create: (body: CreateBrandRequest) =>
    bffFetch<BrandResponse>('/v1/brands', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  get: (id: string) => bffFetch<BrandResponse>(`/v1/brands/${id}`),

  list: (cursor?: string) =>
    bffFetch<PaginatedResponse<BrandResponse>>(
      `/v1/brands${cursor ? `?cursor=${cursor}` : ''}`,
    ),

  switchBrand: (id: string) =>
    bffFetch<OkResponse>(`/v1/brands/${id}/switch`, {
      method: 'POST',
      idempotencyKey: generateRequestId(),
    }),
};

// ── Members ───────────────────────────────────────────────────────────────────

export const membersApi = {
  list: (cursor?: string) =>
    bffFetch<PaginatedResponse<MemberResponse>>(
      `/v1/members${cursor ? `?cursor=${cursor}` : ''}`,
    ),

  invite: (body: InviteMemberRequest) =>
    bffFetch<OkResponse>('/v1/invites', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  acceptInvite: (body: AcceptInviteRequest) =>
    bffFetch<OkResponse>('/v1/invites/accept', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  updateRole: (memberId: string, body: UpdateMemberRoleRequest) =>
    bffFetch<OkResponse>(`/v1/members/${memberId}/role`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  remove: (memberId: string) =>
    bffFetch<OkResponse>(`/v1/members/${memberId}`, {
      method: 'DELETE',
      idempotencyKey: generateRequestId(),
    }),
};

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
      coming_soon: true,
    });
  }

  // Google Ads — coming soon
  if (google.coming_soon) {
    items.push({
      provider: 'google',
      display_name: 'Google Ads',
      description: 'Connect your Google Ads account for search campaign data.',
      coming_soon: true,
    });
  }

  return items;
}

export const connectorsApi = {
  /** Returns ConnectorListItem[] — unwraps the BFF envelope { request_id, data: {...} }. */
  list: async (): Promise<ConnectorListItem[]> => {
    const raw = await bffFetch<RawConnectorListEnvelope>('/v1/connectors');
    return mapConnectorList(raw);
  },

  // Shopify OAuth requires the store domain (e.g. my-store.myshopify.com) — the
  // backend 400s (MISSING_SHOP_PARAM) without it.
  getShopifyInstallUrl: (shop: string) =>
    bffFetch<ShopifyInstallUrlResponse>(
      `/v1/connectors/shopify/install?shop=${encodeURIComponent(shop)}`,
    ),

  getStatus: (connectorId: string) =>
    bffFetch<ConnectorInstanceResponse>(`/v1/connectors/${connectorId}/status`),

  disconnect: (connectorId: string) =>
    bffFetch<OkResponse>(`/v1/connectors/${connectorId}`, {
      method: 'DELETE',
      idempotencyKey: generateRequestId(),
    }),
};

// ── Pixel ─────────────────────────────────────────────────────────────────────

interface RawPixelInstallation {
  installed: boolean;
  installation_id?: string;
  install_token?: string;
  target_host?: string;
  snippet_html?: string;
  is_new?: boolean;
}

function mapPixel(d: RawPixelInstallation): PixelInstallationResponse {
  return {
    installed: d.installed,
    installation_id: d.installation_id,
    install_token: d.install_token,
    target_host: d.target_host,
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

  verify: () =>
    bffFetch<OkResponse>('/v1/pixel/verify', {
      method: 'POST',
      idempotencyKey: generateRequestId(),
    }),

  getHealth: () => bffFetch<PixelHealthResponse>('/v1/pixel/health'),
};

// ── Dashboard (Postgres-only reads — arch plan §6.4) ─────────────────────────
//
// The BFF wraps every dashboard payload in a { request_id, data } envelope and uses
// its own field names (org_name, shopify.syncState, step.key, …). These adapters
// unwrap the envelope and map the BFF shape onto the component-facing types declared
// in ./types, so the card components and their types stay unchanged.

interface BffEnvelope<T> {
  request_id: string;
  data: T;
}

interface RawBrandSummary {
  org_name: string | null;
  brand_count: number;
  member_count: number;
  brands: Array<{ id: string; display_name: string; domain: string | null; status: string }>;
}

interface RawConnectionStatus {
  shopify: {
    connected: boolean;
    status: string | null;
    syncState: string | null;
    lastSyncAt: string | null;
  };
  meta: { coming_soon: boolean };
  google: { coming_soon: boolean };
}

interface RawDataStatus {
  pixel: { installed: boolean; state: string | null; verifiedAt: string | null };
}

interface RawOnboarding {
  steps: Array<{ key: string; label: string; completed: boolean }>;
  completed_count: number;
  total_count: number;
  all_complete: boolean;
}

/** Maps an onboarding step key to the route that completes it (none for already-done steps). */
const ONBOARDING_STEP_ROUTE: Record<string, string | undefined> = {
  email_verified: undefined,
  workspace_created: '/workspace/new',
  brand_created: '/brand/new',
  shopify_connected: '/settings/connectors',
  pixel_installed: '/settings/pixel',
};

export const dashboardApi = {
  // null → no brand yet → card renders its "No Data Yet" empty state.
  getBrandSummary: async (): Promise<DashboardBrandSummaryResponse | null> => {
    const { data } = await bffFetch<BffEnvelope<RawBrandSummary>>('/v1/dashboard/brand-summary');
    if (!data || data.brand_count === 0) return null;
    return {
      workspace_name: data.org_name ?? '',
      brand_name: data.brands[0]?.display_name ?? '',
      member_count: data.member_count,
    };
  },

  getConnectionStatus: async (): Promise<DashboardConnectionStatusResponse> => {
    const { data } = await bffFetch<BffEnvelope<RawConnectionStatus>>(
      '/v1/dashboard/connection-status',
    );
    const s = data?.shopify;
    return {
      connector_status: (s?.status ?? null) as DashboardConnectionStatusResponse['connector_status'],
      // null sync_state → card shows its empty state.
      sync_state: (s?.connected ? s.syncState : null) as DashboardConnectionStatusResponse['sync_state'],
      last_sync_at: s?.lastSyncAt ?? null,
      provider: (s?.connected ? 'shopify' : null) as DashboardConnectionStatusResponse['provider'],
    };
  },

  getDataStatus: async (): Promise<DashboardDataStatusResponse> => {
    const { data } = await bffFetch<BffEnvelope<RawDataStatus>>('/v1/dashboard/data-status');
    const p = data?.pixel;
    return {
      // null pixel_state → card shows its empty state.
      pixel_state: (p?.installed ? p.state : null) as DashboardDataStatusResponse['pixel_state'],
      pixel_installed_at: p?.verifiedAt ?? null,
    };
  },

  getOnboardingProgress: async (): Promise<DashboardOnboardingResponse> => {
    const { data } = await bffFetch<BffEnvelope<RawOnboarding>>(
      '/v1/dashboard/onboarding-progress',
    );
    const steps = (data?.steps ?? []).map((s) => ({
      id: s.key,
      label: s.label,
      completed: s.completed,
      route: ONBOARDING_STEP_ROUTE[s.key],
    }));
    return { steps, all_complete: data?.all_complete ?? false };
  },
};
