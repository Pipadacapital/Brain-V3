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
} from './types';

/** All BFF routes proxied through Next.js API routes → frontend-api module */
const BFF_BASE = '/api/bff';

function generateRequestId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
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
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Request-Id': requestId,
    ...(options.idempotencyKey
      ? { 'Idempotency-Key': options.idempotencyKey }
      : {}),
    ...(options.headers as Record<string, string> | undefined),
  };

  const response = await fetch(`${BFF_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include', // send httpOnly cookie
  });

  if (!response.ok) {
    let errorBody: { request_id?: string; error?: { code?: string; message?: string } } = {};
    try {
      errorBody = await response.json();
    } catch {
      // non-JSON error body
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
  login: (body: LoginRequest) =>
    bffFetch<LoginResponse>('/v1/bff/session', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

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
    bffFetch<PaginatedResponse<WorkspaceResponse>>(
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

export const connectorsApi = {
  list: () => bffFetch<ConnectorListItem[]>('/v1/connectors'),

  getShopifyInstallUrl: () =>
    bffFetch<ShopifyInstallUrlResponse>('/v1/connectors/shopify/install'),

  getStatus: (connectorId: string) =>
    bffFetch<ConnectorInstanceResponse>(`/v1/connectors/${connectorId}/status`),

  disconnect: (connectorId: string) =>
    bffFetch<OkResponse>(`/v1/connectors/${connectorId}`, {
      method: 'DELETE',
      idempotencyKey: generateRequestId(),
    }),
};

// ── Pixel ─────────────────────────────────────────────────────────────────────

export const pixelApi = {
  getInstallation: () => bffFetch<PixelInstallationResponse>('/v1/pixel/installation'),

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
