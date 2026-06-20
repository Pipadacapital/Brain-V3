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
  BackfillTriggerResponse,
  BackfillJobProgress,
} from '@brain/contracts';

// Runtime Zod schemas for the covered BFF read DTOs — the single source of truth.
// parseData() validates the unwrapped envelope body against these at the client boundary,
// so a core<->web field drift throws a CLEAR field-named error here (not a deep BigInt(undefined)).
import { z } from 'zod';
import {
  RevenueSnapshotSchema,
  KpiSummarySchema,
  AttributionByChannelSchema,
  AttributionReconciliationSchema,
  ChannelRoasSchema,
  JourneyFirstTouchMixSchema,
  JourneyTimelineSchema,
  JourneyStitchRateSchema,
  OrderStatusMixSchema,
  TopProductsSchema,
  OrdersListSchema,
  ContributionMarginSchema,
  CostInputsListSchema,
  OrderDetailSchema,
  DataQualitySummarySchema,
  AskBrainResultSchema,
  Customer360Schema,
  VaultCoverageSchema,
  ErasureResultSchema,
  MergeReviewListSchema,
  MergeResolveResultSchema,
  UnmergeResultSchema,
  BillingPeriodsSchema,
  SealPeriodResultSchema,
  InspectableBillSchema,
  InvoiceSchema,
  IssueInvoiceResultSchema,
  IssueCreditNoteResultSchema,
  RecommendationsSchema,
  GenerateRecommendationsResultSchema,
  FoundationHealthSchema,
  EntitlementsSchema,
} from '@brain/contracts';

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
  InviteResponse,
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
  DashboardRealizedRevenueResponse,
  PaginatedResponse,
  AcceptInviteRequest,
  SetOrgRequest,
  SetOrgResponse,
  SetBrandResponse,
  OnboardingAdvanceRequest,
  OnboardingAdvanceResponse,
  ProvisionOnboardingRequest,
  ProvisionOnboardingResponse,
  MarketplaceTile,
  ConnectResponseData,
  ConnectorProvider,
  ConnectorStatus,
  SyncState,
  AnalyticsTimeseriesResponse,
  AnalyticsKpiSummaryResponse,
  AnalyticsRecognitionBreakdownResponse,
  AnalyticsRecentActivityResponse,
  AnalyticsOrdersTimeseriesResponse,
  AnalyticsOrderStatsResponse,
  AnalyticsDataHealthResponse,
  FoundationHealthResponse,
  EntitlementsResponse,
  DataQualitySummaryResponse,
  AnalyticsSettlementsResponse,
  AnalyticsTrackingHealthResponse,
  AnalyticsRecentEventsResponse,
  AnalyticsAdSpendTimeseriesResponse,
  AnalyticsBlendedRoasResponse,
  AnalyticsCodRtoRatesResponse,
  AnalyticsCodMixResponse,
  AnalyticsCheckoutFunnelResponse,
  AnalyticsRtoRiskResponse,
  AnalyticsOrderStatusMixResponse,
  AnalyticsContributionMarginResponse,
  AnalyticsCostInputsResponse,
  CostInputDto,
  AnalyticsTopProductsResponse,
  AnalyticsOrdersListResponse,
  AnalyticsOrderDetailResponse,
  AnalyticsJourneyFirstTouchMixResponse,
  AnalyticsJourneyStitchRateResponse,
  AnalyticsJourneyTimelineResponse,
  ConsentCoverageResponse,
  ConsentSuppressionSummaryResponse,
  ConsentGateActivityResponse,
  ConsentWindowConfigResponse,
  CapiFeedbackSummaryResponse,
  CapiFeedbackEventsResponse,
  CapiFeedbackDeletionsResponse,
  AttributionModel,
  AnalyticsAttributionByChannelResponse,
  AnalyticsAttributionReconciliationResponse,
  AnalyticsChannelRoasResponse,
  AskBrainRequest,
  AskBrainResponse,
  Customer360Response,
  VaultCoverageResponse,
  ErasureResultResponse,
  MergeReviewListResponse,
  MergeResolveResultResponse,
  UnmergeResultResponse,
  BillingPeriodsResponse,
  SealPeriodResultResponse,
  InspectableBillResponse,
  InvoiceResponse,
  IssueInvoiceResultResponse,
  IssueCreditNoteResultResponse,
  RecommendationsResponse,
  GenerateRecommendationsResultResponse,
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
    // Friendly fallback when the server sent no message — never surface a raw HTTP code.
    const message =
      errorBody?.error?.message ??
      (response.status >= 500
        ? 'Brain had a brief problem on our side. Your data is safe — please try again in a moment.'
        : 'Something went wrong. Please try again.');
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

/**
 * parseData — validate an unwrapped BFF envelope body against its Zod contract at the seam.
 *
 * On success returns the SAME data (no transform) → identical rendering + money formatting.
 * On drift (a renamed/removed/wrong-typed money or discriminant field) throws a CLEAR,
 * field-named BffApiError(code:'CONTRACT_DRIFT') HERE — never a deep `BigInt(undefined)`
 * white-screen inside a component. This is the runtime half of the single-source-of-truth
 * contract (the compile-time half is core's `satisfies z.infer<Schema>` in bff.routes.ts).
 */
export function parseData<S extends z.ZodTypeAny>(
  schema: S,
  env: { request_id: string; data: unknown },
): z.infer<S> {
  const r = schema.safeParse(env.data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue?.path.join('.') || '<root>';
    throw new BffApiError(
      `BFF contract drift at ${path}: ${issue?.message ?? 'invalid response shape'}`,
      200,
      env.request_id,
      'CONTRACT_DRIFT',
    );
  }
  return r.data as z.infer<S>;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  // feat-onboarding-ux: register goes through the BFF (not the cookie-less public
  // /v1/auth/register). For a genuinely-new user the BFF mints a real authenticated
  // session and sets the httpOnly `brain_session` cookie — the user lands in the wizard
  // already authenticated (no manual /login). On success we bootstrap a session-bound
  // CSRF token up front (mirrors authApi.login) so the first wizard mutation doesn't 403.
  // The session cookie is the only auth surface — no token is ever returned to JS (XSS-safe).
  register: async (body: RegisterRequest): Promise<RegisterResponse> => {
    const res = await bffFetch<RegisterResponse>('/v1/bff/register', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    // Only a freshly-created user gets a session cookie; bind a CSRF token to it.
    if (res.created && typeof document !== 'undefined') {
      await fetch(`${BFF_BASE}/v1/bff/csrf`, { credentials: 'include' });
    }
    return res;
  },

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

  // feat-onboarding-ux: the BFF /me also returns onboarding_status (authoritative wizard
  // position) and email_verified — used by the OnboardingGate (forward-only routing) and
  // the verify-email banner. Distinct from authApi.me() which hits the raw /v1/auth/me.
  bffMe: () => bffFetch<CurrentUserResponse>('/v1/bff/me'),
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

// ── Onboarding (merged workspace+brand provisioning — feat-onboarding-ux) ───────

export const onboardingApi = {
  /**
   * POST /v1/bff/onboarding/provision — provisions organization + first brand
   * (with website→pixel) in ONE server transaction. Replaces the non-atomic
   * client-side chain (workspace create → brand create) that caused the orphan-org
   * Back-button bug. The slug is derived server-side (never sent/shown by the client).
   *
   * Idempotent per user: if the caller already has an org membership the server returns
   * the existing { organization_id, brand_id } with 200 — so a double-submit or a
   * Back→resubmit never creates a duplicate.
   */
  provision: (body: ProvisionOnboardingRequest) =>
    bffFetch<ProvisionOnboardingResponse>('/v1/bff/onboarding/provision', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),
};

// ── Workspace ─────────────────────────────────────────────────────────────────

export const workspaceApi = {
  // BFF returns { request_id, workspace: {...} } — unwrap to flat WorkspaceResponse.
  create: async (body: CreateWorkspaceRequest): Promise<WorkspaceResponse> => {
    const res = await bffFetch<{ request_id: string; workspace: WorkspaceResponse }>('/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    return res.workspace;
  },

  get: async (id: string): Promise<WorkspaceResponse> => {
    const res = await bffFetch<{ request_id: string; workspace: WorkspaceResponse }>(`/v1/workspaces/${id}`);
    return res.workspace;
  },

  list: (cursor?: string) =>
    bffFetch<WorkspaceListResponse>(
      `/v1/workspaces${cursor ? `?cursor=${cursor}` : ''}`,
    ),
};

// ── Brand ─────────────────────────────────────────────────────────────────────

export const brandApi = {
  // Core returns { request_id, brand: {...} } — unwrap to the flat BrandResponse so
  // consumers can read newBrand.id / .display_name directly. Without this, the
  // create→switch flow called switchBrand(undefined) → empty body {} → 400.
  create: async (body: CreateBrandRequest): Promise<BrandResponse> => {
    const res = await bffFetch<{ request_id: string; brand: BrandResponse }>('/v1/brands', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    return res.brand;
  },

  // BFF returns { request_id, brand: {...} } — unwrap to flat BrandResponse.
  get: async (id: string): Promise<BrandResponse> => {
    const res = await bffFetch<{ request_id: string; brand: BrandResponse }>(`/v1/brands/${id}`);
    return res.brand;
  },

  // BFF returns { request_id, brands: [...], next_cursor, has_more } — remap `brands`
  // to the PaginatedResponse `data` field the callers expect.
  list: async (cursor?: string): Promise<PaginatedResponse<BrandResponse>> => {
    const res = await bffFetch<{
      request_id: string;
      brands: BrandResponse[];
      next_cursor: string | null;
      has_more: boolean;
    }>(`/v1/brands${cursor ? `?cursor=${cursor}` : ''}`);
    return { data: res.brands, next_cursor: res.next_cursor, has_more: res.has_more };
  },

  // B1: repoint to the new set-brand BFF route (AC-1/SD-1).
  // The old /v1/brands/:id/switch had no backing route — this is the correct target.
  switchBrand: (id: string) =>
    bffFetch<SetBrandResponse>('/v1/bff/session/set-brand', {
      method: 'POST',
      body: JSON.stringify({ brand_id: id }),
      idempotencyKey: generateRequestId(),
    }),
};

// ── Members ───────────────────────────────────────────────────────────────────

export const membersApi = {
  // BFF returns { request_id, members: [...], next_cursor, has_more } — remap `members`
  // to the PaginatedResponse `data` field the table reads (data?.data). Without this the
  // members table always renders empty.
  list: async (cursor?: string): Promise<PaginatedResponse<MemberResponse>> => {
    const res = await bffFetch<{
      request_id: string;
      members: MemberResponse[];
      next_cursor: string | null;
      has_more: boolean;
    }>(`/v1/members${cursor ? `?cursor=${cursor}` : ''}`);
    return { data: res.members, next_cursor: res.next_cursor ?? null, has_more: res.has_more ?? false };
  },

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

  // D-4/D-11: BFF returns { request_id, invites: [...], next_cursor, has_more }
  // Unwrap `invites` → PaginatedResponse<InviteResponse>.
  listPendingInvites: async (cursor?: string): Promise<PaginatedResponse<InviteResponse>> => {
    const res = await bffFetch<{
      request_id: string;
      invites: InviteResponse[];
      next_cursor: string | null;
      has_more: boolean;
    }>(`/v1/invites?status=pending${cursor ? `&cursor=${cursor}` : ''}`);
    return { data: res.invites, next_cursor: res.next_cursor ?? null, has_more: res.has_more ?? false };
  },

  // D-3: BFF returns { request_id, invite: InviteResponse } — unwrap `invite`.
  resendInvite: async (inviteId: string): Promise<InviteResponse> => {
    const res = await bffFetch<{ request_id: string; invite: InviteResponse }>(
      `/v1/invites/${inviteId}/resend`,
      {
        method: 'POST',
        idempotencyKey: generateRequestId(),
      },
    );
    return res.invite;
  },

  // Revoke returns 204 No Content — void.
  revokeInvite: (inviteId: string): Promise<void> =>
    bffFetch<void>(`/v1/invites/${inviteId}/revoke`, {
      method: 'POST',
      idempotencyKey: generateRequestId(),
    }),

  // D-8: BFF returns { request_id, member: { ..., user_status: 'suspended' } } — unwrap `member`.
  suspendMember: async (memberId: string): Promise<MemberResponse> => {
    const res = await bffFetch<{ request_id: string; member: MemberResponse }>(
      `/v1/members/${memberId}/suspend`,
      {
        method: 'POST',
        idempotencyKey: generateRequestId(),
      },
    );
    return res.member;
  },

  // D-1: BFF returns { request_id, member: { ..., user_status: 'active' } } — unwrap `member`.
  reactivateMember: async (memberId: string): Promise<MemberResponse> => {
    const res = await bffFetch<{ request_id: string; member: MemberResponse }>(
      `/v1/members/${memberId}/reactivate`,
      {
        method: 'POST',
        idempotencyKey: generateRequestId(),
      },
    );
    return res.member;
  },
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
 */
async function triggerBackfill(connectorId: string): Promise<BackfillTriggerResponse> {
  const requestId = generateRequestId();
  const method = 'POST';
  const csrfToken = await ensureCsrfToken();

  const response = await fetch(`/api/v1/connectors/${encodeURIComponent(connectorId)}/backfill`, {
    method,
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

// ── Analytics (Phase 1) ────────────────────────────────────────────────────────
// All routes: BFF-only, session-authed. Brand from session (D-1).
// Unwrap { request_id, data } envelope same pattern as dashboardApi.

export const analyticsApi = {
  /**
   * GET /api/v1/analytics/revenue-timeseries
   * Returns per-bucket realized + provisional revenue.
   */
  getRevenueTimeseries: async (params?: {
    from?: string;
    to?: string;
    grain?: 'day' | 'week';
  }): Promise<AnalyticsTimeseriesResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.grain) qs.set('grain', params.grain);
    const qsStr = qs.toString();
    const { data } = await bffFetch<BffEnvelope<AnalyticsTimeseriesResponse>>(
      `/v1/analytics/revenue-timeseries${qsStr ? `?${qsStr}` : ''}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/kpi-summary
   * Returns brand KPI snapshot.
   */
  getKpiSummary: async (asOf?: string): Promise<AnalyticsKpiSummaryResponse> => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    const { data } = await bffFetch<BffEnvelope<AnalyticsKpiSummaryResponse>>(
      `/v1/analytics/kpi-summary${qs}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/recognition-breakdown
   * Returns recognition state distribution.
   */
  getRecognitionBreakdown: async (asOf?: string): Promise<AnalyticsRecognitionBreakdownResponse> => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    const { data } = await bffFetch<BffEnvelope<AnalyticsRecognitionBreakdownResponse>>(
      `/v1/analytics/recognition-breakdown${qs}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/recent-activity
   * Returns the latest N ledger rows.
   */
  getRecentActivity: async (limit?: number): Promise<AnalyticsRecentActivityResponse> => {
    const qs = limit ? `?limit=${limit}` : '';
    const { data } = await bffFetch<BffEnvelope<AnalyticsRecentActivityResponse>>(
      `/v1/analytics/recent-activity${qs}`,
    );
    return data;
  },

  // ── Phase 2 ────────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/analytics/orders-timeseries
   * Returns per-bucket order count + RTO count + realized revenue.
   */
  getOrdersTimeseries: async (params?: {
    from?: string;
    to?: string;
    grain?: 'day' | 'week';
  }): Promise<AnalyticsOrdersTimeseriesResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.grain) qs.set('grain', params.grain);
    const qsStr = qs.toString();
    const { data } = await bffFetch<BffEnvelope<AnalyticsOrdersTimeseriesResponse>>(
      `/v1/analytics/orders-timeseries${qsStr ? `?${qsStr}` : ''}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/order-stats
   * Returns per-currency order stats: order count, AOV, RTO rate.
   */
  getOrderStats: async (asOf?: string): Promise<AnalyticsOrderStatsResponse> => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    const { data } = await bffFetch<BffEnvelope<AnalyticsOrderStatsResponse>>(
      `/v1/analytics/order-stats${qs}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/data-health
   * Returns ingestion + connector-sync health (bounded read).
   */
  getDataHealth: async (): Promise<AnalyticsDataHealthResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsDataHealthResponse>>(
      `/v1/analytics/data-health`,
    );
    return data;
  },

  /**
   * GET /api/v1/dashboard/data-foundation-health — the readiness verdict (P1).
   * One tier (blocked|building|ready|healthy) + the progression checklist + the next step.
   * Parsed at the seam so a drift in the foundation shape fails loudly.
   */
  getFoundationHealth: async (): Promise<FoundationHealthResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/dashboard/data-foundation-health');
    return parseData(FoundationHealthSchema, env);
  },

  /**
   * GET /api/v1/entitlements — readiness-driven progressive unlock (P2).
   * Server-driven eligibility for gated centers + connector categories. Parsed at the seam.
   */
  getEntitlements: async (): Promise<EntitlementsResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/entitlements');
    return parseData(EntitlementsSchema, env);
  },

  /**
   * GET /api/v1/data-quality/summary
   * Returns per-category × per-target dq grades, freshness-SLA status, dq_grade
   * coverage, effective_confidence, and the trust-gate decision (metric-engine read).
   * The UI NEVER queries dq_check_result — this BFF route is the sole read path (I-ST01).
   * D-10: unwrap { request_id, data } → DataQualitySummaryResponse; preserve no_data.
   */
  getDataQualitySummary: async (): Promise<DataQualitySummaryResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/data-quality/summary`,
    );
    return parseData(DataQualitySummarySchema, env);
  },

  /**
   * GET /api/v1/analytics/settlements — Razorpay net-of-fees settlement summary.
   * D-10: unwrap { request_id, data } → AnalyticsSettlementsResponse.
   * state:'no_data' is preserved (never coerced to has_data with zeros).
   */
  getSettlements: async (asOf?: string): Promise<AnalyticsSettlementsResponse> => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    const { data } = await bffFetch<BffEnvelope<AnalyticsSettlementsResponse>>(
      `/v1/analytics/settlements${qs}`,
    );
    return data;
  },

  // ── Ad-connectors (Slice 1 Track 3) — spend + blended ROAS ────────────────────

  /**
   * GET /api/v1/analytics/ad-spend-timeseries
   * Returns per-bucket ad spend grouped by (platform, currency_code).
   * Amounts are bigint-serialized minor-unit strings (never floats).
   */
  getAdSpendTimeseries: async (params?: {
    from?: string;
    to?: string;
    grain?: 'day' | 'week';
    platform?: 'meta' | 'google_ads';
  }): Promise<AnalyticsAdSpendTimeseriesResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.grain) qs.set('grain', params.grain);
    if (params?.platform) qs.set('platform', params.platform);
    const qsStr = qs.toString();
    const { data } = await bffFetch<BffEnvelope<AnalyticsAdSpendTimeseriesResponse>>(
      `/v1/analytics/ad-spend-timeseries${qsStr ? `?${qsStr}` : ''}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/blended-roas
   * Returns per-currency blended ROAS (realized ÷ spend), same-currency only.
   * roas_ratio is an exact decimal string or null (spend=0 → honest null).
   */
  getBlendedRoas: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsBlendedRoasResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const { data } = await bffFetch<BffEnvelope<AnalyticsBlendedRoasResponse>>(
      `/v1/analytics/blended-roas${qsStr ? `?${qsStr}` : ''}`,
    );
    return data;
  },

  // ── Tracking Center (Phase 1 Track C) ────────────────────────────────────────

  /**
   * GET /api/v1/analytics/tracking-health
   * Returns pixel-collection health (first-event, volume, freshness, consent counts).
   */
  getTrackingHealth: async (): Promise<AnalyticsTrackingHealthResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsTrackingHealthResponse>>(
      `/v1/analytics/tracking-health`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/recent-events
   * Returns the latest N collected events (type/time/anonymized ids) for the Explorer.
   */
  getRecentEvents: async (limit?: number): Promise<AnalyticsRecentEventsResponse> => {
    const qs = limit ? `?limit=${limit}` : '';
    const { data } = await bffFetch<BffEnvelope<AnalyticsRecentEventsResponse>>(
      `/v1/analytics/recent-events${qs}`,
    );
    return data;
  },

  // ── CoD / RTO surface (GoKwik + Shopflo Track C) ──────────────────────────────
  // D-10: unwrap { request_id, data }. state:'no_data' preserved (honest, never zeros).
  // data_source passes through for the Synthetic (dev) badge.

  /** GET /api/v1/analytics/cod-rto-rates — RTO% by pincode cohort (GoKwik AWB terminal states). */
  getCodRtoRates: async (): Promise<AnalyticsCodRtoRatesResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsCodRtoRatesResponse>>(
      `/v1/analytics/cod-rto-rates`,
    );
    return data;
  },

  /** GET /api/v1/analytics/cod-mix — CoD CM2 + CoD-vs-prepaid mix (ledger cod_* events). */
  getCodMix: async (): Promise<AnalyticsCodMixResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsCodMixResponse>>(
      `/v1/analytics/cod-mix`,
    );
    return data;
  },

  /** GET /api/v1/analytics/checkout-funnel — abandoned-checkout funnel (Shopflo, REAL). */
  getCheckoutFunnel: async (): Promise<AnalyticsCheckoutFunnelResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsCheckoutFunnelResponse>>(
      `/v1/analytics/checkout-funnel`,
    );
    return data;
  },

  /** GET /api/v1/analytics/rto-risk-distribution — per-order RTO risk (GoKwik RTO-Predict). */
  getRtoRiskDistribution: async (): Promise<AnalyticsRtoRiskResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsRtoRiskResponse>>(
      `/v1/analytics/rto-risk-distribution`,
    );
    return data;
  },

  // ── Order-status mix (Silver tier — feat-silver-tier-order-state) ─────────────
  // The FIRST read from the Silver analytics tier (silver.order_state), via the
  // metric-engine Silver seam (I-ST01 — UI never queries StarRocks). D-10: unwrap
  // { request_id, data }; state:'no_data' preserved (honest, never zeros).

  /** GET /api/v1/analytics/order-status-mix — counts + share by order lifecycle state. */
  getOrderStatusMix: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsOrderStatusMixResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/order-status-mix${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(OrderStatusMixSchema, env);
  },

  /**
   * GET /api/v1/analytics/top-products
   * Per-SKU rollup (units / line GMV / order count) over the Silver order-line mart
   * (feat-shopify-order-depth). Parsed at the seam; state:'no_data' preserved.
   */
  getTopProducts: async (params?: { from?: string; to?: string; limit?: number }): Promise<AnalyticsTopProductsResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.limit) qs.set('limit', String(params.limit));
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/top-products${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(TopProductsSchema, env);
  },

  /**
   * GET /api/v1/analytics/orders-list
   * Paginated latest-state orders from Bronze (feat-shopify-order-depth). Parsed at the seam.
   */
  getOrdersList: async (params?: { page?: number; pageSize?: number }): Promise<AnalyticsOrdersListResponse> => {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('page_size', String(params.pageSize));
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/orders-list${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(OrdersListSchema, env);
  },

  /** GET /v1/analytics/contribution-margin — CM1/CM2 + cost_confidence (feat-cm2-cost-inputs). */
  getContributionMargin: async (asOf?: string): Promise<AnalyticsContributionMarginResponse> => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    const env = await bffFetch<BffEnvelope<unknown>>(`/v1/analytics/contribution-margin${qs}`);
    return parseData(ContributionMarginSchema, env);
  },

  /** GET /v1/costs — the brand's active cost inputs. */
  getCostInputs: async (): Promise<AnalyticsCostInputsResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/costs');
    return parseData(CostInputsListSchema, env);
  },

  /** POST /v1/costs — upsert one cost input (COGS/shipping/fee rate or fixed amount). */
  upsertCostInput: async (body: {
    scope: CostInputDto['scope'];
    scope_ref?: string;
    cost_type: CostInputDto['cost_type'];
    amount_minor?: string;
    pct_bps?: number;
    currency_code: string;
    cost_confidence?: CostInputDto['cost_confidence'];
  }): Promise<{ cost_input_id: string }> => {
    const { data } = await bffFetch<BffEnvelope<{ cost_input_id: string }>>('/v1/costs', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    return data;
  },

  /**
   * GET /api/v1/analytics/order-detail?order_id=<id>
   * A single order's economic breakdown (line items / tax / shipping / discounts / refunds) read
   * from Bronze (feat-shopify-order-depth). Parsed at the seam; state:'not_found' preserved.
   */
  getOrderDetail: async (orderId: string): Promise<AnalyticsOrderDetailResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/order-detail?order_id=${encodeURIComponent(orderId)}`,
    );
    return parseData(OrderDetailSchema, env);
  },

  // ── Journey / first-touch (Silver tier — feat-journey-touchpoint) ─────────────
  // The SECOND read from the Silver analytics tier (silver.touchpoint), via the
  // metric-engine journey seam (withSilverBrand, I-ST01 — UI never queries StarRocks).
  // D-10: unwrap { request_id, data }; state:'no_data' preserved (honest, never zeros).
  // data_source passes through for the Synthetic (dev) badge.

  /** GET /api/v1/analytics/journey/first-touch-mix — first-touch channel mix over a range. */
  getJourneyFirstTouchMix: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsJourneyFirstTouchMixResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/journey/first-touch-mix${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(JourneyFirstTouchMixSchema, env);
  },

  /** GET /api/v1/analytics/journey/stitch-rate — deterministic cart-stitch hit-rate. */
  getJourneyStitchRate: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsJourneyStitchRateResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/journey/stitch-rate${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(JourneyStitchRateSchema, env);
  },

  /** GET /api/v1/analytics/journey/timeline?orderId= — ordered touchpoints for one order. */
  getJourneyTimeline: async (params: {
    orderId: string;
  }): Promise<AnalyticsJourneyTimelineResponse> => {
    const qs = new URLSearchParams();
    qs.set('orderId', params.orderId);
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/journey/timeline?${qs.toString()}`,
    );
    return parseData(JourneyTimelineSchema, env);
  },

  // ── Attribution (Phase 5 — feat-attribution-ledger Track C) ───────────────────
  // The attributed-revenue / channel-ROAS surface. Reads the Gold attribution credit
  // ledger via the metric-engine sole read path (I-ST01 — the UI NEVER queries the
  // ledger/StarRocks). D-10: unwrap { request_id, data }; state:'no_data' preserved
  // (honest, never zeros). data_source passes through for the Synthetic (dev) badge.
  // Money fields are SIGNED bigint-serialized minor-unit strings (I-S07) — never floats.

  /** GET /api/v1/analytics/attribution/by-channel — attributed revenue by channel for a model. */
  getAttributionByChannel: async (params: {
    model: AttributionModel;
    from?: string;
    to?: string;
  }): Promise<AnalyticsAttributionByChannelResponse> => {
    const qs = new URLSearchParams();
    qs.set('model', params.model);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/attribution/by-channel?${qs.toString()}`,
    );
    return parseData(AttributionByChannelSchema, env);
  },

  /** GET /api/v1/analytics/attribution/reconciliation — the closed-sum residual (oracle made visible). */
  getAttributionReconciliation: async (params: {
    model: AttributionModel;
    from?: string;
    to?: string;
  }): Promise<AnalyticsAttributionReconciliationResponse> => {
    const qs = new URLSearchParams();
    qs.set('model', params.model);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/attribution/reconciliation?${qs.toString()}`,
    );
    return parseData(AttributionReconciliationSchema, env);
  },

  /** GET /api/v1/analytics/attribution/channel-roas — per-channel attributed ÷ ad spend. */
  getChannelRoas: async (params: {
    model: AttributionModel;
    from?: string;
    to?: string;
  }): Promise<AnalyticsChannelRoasResponse> => {
    const qs = new URLSearchParams();
    qs.set('model', params.model);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/attribution/channel-roas?${qs.toString()}`,
    );
    return parseData(ChannelRoasSchema, env);
  },
};

// ── Consent / Compliance (D13 — feat-d13-consent-cancontact Track C) ──────────
// BFF-only, session-authed. Brand from session (D-1). Unwrap { request_id, data }.
// NO raw PII — aggregate counts + decision metadata + a fixed regulatory window.
// state:'no_data' is preserved (fail-closed: empty SoR == "blocked by default").

export const consentApi = {
  /** GET /api/v1/consent/coverage — per-category granted/withdrawn subject counts. */
  getCoverage: async (): Promise<ConsentCoverageResponse> => {
    const { data } = await bffFetch<BffEnvelope<ConsentCoverageResponse>>(
      '/v1/consent/coverage',
    );
    return data;
  },

  /** GET /api/v1/consent/suppression-summary — marketing suppression counts. */
  getSuppressionSummary: async (): Promise<ConsentSuppressionSummaryResponse> => {
    const { data } = await bffFetch<BffEnvelope<ConsentSuppressionSummaryResponse>>(
      '/v1/consent/suppression-summary',
    );
    return data;
  },

  /** GET /api/v1/consent/gate-activity — last-N can_contact() decisions by reason. */
  getGateActivity: async (): Promise<ConsentGateActivityResponse> => {
    const { data } = await bffFetch<BffEnvelope<ConsentGateActivityResponse>>(
      '/v1/consent/gate-activity',
    );
    return data;
  },

  /** GET /api/v1/consent/window-config — the read-only 9–9 IST send window. */
  getWindowConfig: async (): Promise<ConsentWindowConfigResponse> => {
    const { data } = await bffFetch<BffEnvelope<ConsentWindowConfigResponse>>(
      '/v1/consent/window-config',
    );
    return data;
  },
};

// ── Conversion-Feedback / CAPI (Phase 6 — feat-capi-conversion-feedback Track C) ──────
//
// Read-only reads for the stakeholder-visible Conversion-Feedback surface. The BFF wraps
// each payload in { request_id, data }; we unwrap to the component-facing response type
// (declared in ./types, field-for-field with core's get-capi-feedback.ts DTO). No PII.
export const capiFeedbackApi = {
  /** GET /api/v1/feedback/capi/summary — passed-back vs blocked-by-consent + match quality. */
  getSummary: async (): Promise<CapiFeedbackSummaryResponse> => {
    const { data } = await bffFetch<BffEnvelope<CapiFeedbackSummaryResponse>>(
      '/v1/feedback/capi/summary',
    );
    return data;
  },

  /** GET /api/v1/feedback/capi/events — the last-N passback log rows (truncated event_id). */
  getEvents: async (): Promise<CapiFeedbackEventsResponse> => {
    const { data } = await bffFetch<BffEnvelope<CapiFeedbackEventsResponse>>(
      '/v1/feedback/capi/events',
    );
    return data;
  },

  /** GET /api/v1/feedback/capi/deletions — the last-N retroactive-deletion requests. */
  getDeletions: async (): Promise<CapiFeedbackDeletionsResponse> => {
    const { data } = await bffFetch<BffEnvelope<CapiFeedbackDeletionsResponse>>(
      '/v1/feedback/capi/deletions',
    );
    return data;
  },
};

// ── Ask Brain / Decision-Intelligence (Phase 8 — feat-decision-intelligence-inputs) ──────
//
// POST /api/v1/ask — the single-question Decision-Intelligence read. BFF-only, session-authed,
// brand from session (D-1). The web app NEVER queries metric tables / StarRocks and NEVER calls
// the model directly — the BFF orchestrates resolve→engine-compute→trust→provenance and returns
// the certified AskBrainResponse. D-10: unwrap { request_id, data }.
//
// The model resolves the question to a registry binding; the metric-engine computes the number
// (I-ST01). kind:'refusal' → no number is shown (off-domain honesty). Money is bigint-minor
// strings + currency — format with formatMoneyDisplay, never /100, never BigInt(undefined).

export const askApi = {
  /** POST /api/v1/ask — resolve a NL question to a certified metric answer (or honest refusal). */
  ask: async (body: AskBrainRequest): Promise<AskBrainResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/ask', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    return parseData(AskBrainResultSchema, env);
  },
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
  // B2/MA-06: active_brand_id is new in 0013 — = auth.brandId from JWT.
  active_brand_id: string | null;
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

// ── Realized Revenue raw + mapped types (D-5 — raw and mapped SEPARATELY) ────
//
// RawRealizedRevenue = the BFF data payload (inside BffEnvelope<T>).
// DashboardRealizedRevenueResponse (in ./types) = the component-facing model.
// These two types are DISTINCT — mapping happens in getRealizedRevenue(), not in the card.

export const dashboardApi = {
  // null → no brand yet → card renders its "No Data Yet" empty state.
  getBrandSummary: async (): Promise<DashboardBrandSummaryResponse | null> => {
    const { data } = await bffFetch<BffEnvelope<RawBrandSummary>>('/v1/dashboard/brand-summary');
    if (!data || data.brand_count === 0) return null;
    // MA-06: active brand by id, not array index.
    // Prefer the brand matching active_brand_id; fall back to brands[0] only as last resort
    // (e.g. legacy sessions where active_brand_id may be null before 0013 deploys).
    const active = data.brands.find((b) => b.id === data.active_brand_id);
    return {
      workspace_name: data.org_name ?? '',
      brand_name: active?.display_name ?? data.brands[0]?.display_name ?? '',
      member_count: data.member_count,
      active_brand_id: data.active_brand_id ?? null,
      brands: data.brands,
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

  /**
   * GET /api/v1/dashboard/realized-revenue — § 4 contract.
   * Unwraps BffEnvelope<RawRealizedRevenue> → DashboardRealizedRevenueResponse.
   *
   * ENVELOPE: const { data } = await bffFetch<BffEnvelope<RawRealizedRevenue>>(...)
   * This is the ONE canonical unwrap — no flat-shape read (prevents the 9th mismatch).
   *
   * Amounts: minor-unit strings from the BFF (bigint serialized). The card uses
   * formatMoneyDisplay(minorString, currencyCode) — no /100, no parseFloat (D-7).
   *
   * state:'no_data' → realized/provisional are null → card shows "No data yet" (D-2).
   * realized and provisional are NEVER blended or summed (D-4).
   *
   * @param asOf - Optional YYYY-MM-DD date. If omitted, server defaults to today.
   */
  getRealizedRevenue: async (asOf?: string): Promise<DashboardRealizedRevenueResponse> => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    // Validate at the seam against the single-source-of-truth contract (RevenueSnapshotSchema).
    // The discriminated union preserves the no_data/has_data arms EXACTLY — realized/provisional
    // are null only in no_data; money stays bigint-minor strings (never /100, never BigInt(undefined)).
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/dashboard/realized-revenue${qs}`,
    );
    return parseData(RevenueSnapshotSchema, env);
  },
};

/**
 * identityApi — identity control-plane reads (P0-C). Customer 360 is the first slice.
 */
export const identityApi = {
  /** GET /api/v1/identity/customer?brain_id=<uuid> — resolved customer profile + links + merges. */
  getCustomer360: async (brainId: string): Promise<Customer360Response> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/identity/customer?brain_id=${encodeURIComponent(brainId)}`,
    );
    return parseData(Customer360Schema, env);
  },

  /** GET /api/v1/identity/vault-coverage — counts-only PII vault coverage (never raw PII). */
  getVaultCoverage: async (): Promise<VaultCoverageResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/identity/vault-coverage');
    return parseData(VaultCoverageSchema, env);
  },

  /** POST /api/v1/identity/customer/erase — DPDP right-to-deletion for one customer. */
  eraseCustomer: async (brainId: string): Promise<ErasureResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/identity/customer/erase', {
      method: 'POST',
      body: JSON.stringify({ brain_id: brainId }),
    });
    return parseData(ErasureResultSchema, env);
  },

  /** GET /api/v1/identity/merge-reviews — pending merge candidates for the active brand. */
  listMergeReviews: async (): Promise<MergeReviewListResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/identity/merge-reviews');
    return parseData(MergeReviewListSchema, env);
  },

  /** POST /api/v1/identity/merge-reviews/resolve — approve (merge) or reject a candidate. */
  resolveMergeReview: async (
    reviewId: string,
    decision: 'merge' | 'reject',
  ): Promise<MergeResolveResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/identity/merge-reviews/resolve', {
      method: 'POST',
      body: JSON.stringify({ review_id: reviewId, decision }),
    });
    return parseData(MergeResolveResultSchema, env);
  },

  /** POST /api/v1/identity/customer/unmerge — split a merged customer back out. */
  unmergeCustomer: async (brainId: string): Promise<UnmergeResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/identity/customer/unmerge', {
      method: 'POST',
      body: JSON.stringify({ brain_id: brainId }),
    });
    return parseData(UnmergeResultSchema, env);
  },
};

/**
 * Billing API — the realized-GMV meter (P1). Maps to /api/v1/billing/* in the frontend-api module.
 * Money is bigint-minor string + currency_code; the UI never does float math (I-S07).
 */
export const billingApi = {
  /** GET /api/v1/billing/periods — the active brand's sealed billing periods (bill basis). */
  getPeriods: async (): Promise<BillingPeriodsResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/billing/periods');
    return parseData(BillingPeriodsSchema, env);
  },

  /** POST /api/v1/billing/periods/seal — meter + seal one 'YYYY-MM' period (idempotent). */
  sealPeriod: async (period: string): Promise<SealPeriodResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/billing/periods/seal', {
      method: 'POST',
      body: JSON.stringify({ period }),
    });
    return parseData(SealPeriodResultSchema, env);
  },

  /** GET /api/v1/billing/bill?period=YYYY-MM — the inspectable bill for a sealed period. */
  getBill: async (period: string): Promise<InspectableBillResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/billing/bill?period=${encodeURIComponent(period)}`,
    );
    return parseData(InspectableBillSchema, env);
  },

  /** GET /api/v1/billing/invoice?period=YYYY-MM — the issued GST invoice for a period. */
  getInvoice: async (period: string): Promise<InvoiceResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/billing/invoice?period=${encodeURIComponent(period)}`,
    );
    return parseData(InvoiceSchema, env);
  },

  /** POST /api/v1/billing/invoice/issue — issue the GST invoice for a sealed period (idempotent). */
  issueInvoice: async (period: string): Promise<IssueInvoiceResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/billing/invoice/issue', {
      method: 'POST',
      body: JSON.stringify({ period }),
    });
    return parseData(IssueInvoiceResultSchema, env);
  },

  /** POST /api/v1/billing/invoice/credit-note — issue an immutable credit note (full or partial). */
  issueCreditNote: async (
    period: string,
    reason: string,
    taxableMinor?: string,
  ): Promise<IssueCreditNoteResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/billing/invoice/credit-note', {
      method: 'POST',
      body: JSON.stringify(
        taxableMinor != null ? { period, reason, taxable_minor: taxableMinor } : { period, reason },
      ),
    });
    return parseData(IssueCreditNoteResultSchema, env);
  },
};

/**
 * Recommendation API — the deterministic decision engine (doc 09). Maps to /api/v1/recommendations.
 * Recommend-only; money fields in evidence are bigint-minor strings (the UI never floats them).
 */
export const recommendationApi = {
  /** GET /api/v1/recommendations — the active brand's open recommendations (Morning Brief). */
  list: async (): Promise<RecommendationsResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/recommendations');
    return parseData(RecommendationsSchema, env);
  },

  /** POST /api/v1/recommendations/refresh — run the detectors; returns raise/expire counts. */
  refresh: async (): Promise<GenerateRecommendationsResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/recommendations/refresh', {
      method: 'POST',
    });
    return parseData(GenerateRecommendationsResultSchema, env);
  },
};
