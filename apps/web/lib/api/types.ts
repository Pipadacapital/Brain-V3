/**
 * M1 API types — sourced from packages/contracts (Track 0).
 *
 * NOTE: Track 0 (packages/contracts) will publish these as Zod schemas.
 * Until those are committed, we declare the TypeScript types here so the
 * frontend can typecheck without a running backend.
 *
 * BFF contract gap list (cross-track request to Track 0/1):
 *   - All types below need Zod schema counterparts in packages/contracts/src/api/m1.api.v1.ts
 *   - The BFF (frontend-api module) must expose all endpoints listed in §5.1 of the arch plan
 *
 * @see docs/.engineering-os/runs/.../03-architecture-plan.md §5.1
 */

// ── Error envelope (matches sample.api.v1.ts pattern) ───────────────────────

export interface ApiErrorResponse {
  request_id: string;
  error: {
    code: string;
    message: string;
    fields?: Array<{ field: string; message: string }>;
  };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface RegisterRequest {
  email: string;
  password: string;
  full_name: string;
}

export interface VerifyEmailRequest {
  token: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/** Onboarding status enum — authoritative for wizard routing (replaces needs_onboarding boolean). */
export type OnboardingStatus =
  | 'pending'
  | 'org_created'
  | 'brand_created'
  | 'integration_selected'
  | 'complete';

export interface LoginResponse {
  request_id: string;
  user: {
    id: string;
    email: string;
    email_verified: boolean;
  };
  expires_in: number;
  /** Replaces needs_onboarding: boolean. null = no org membership yet. */
  onboarding_status: OnboardingStatus | null;
  auth: {
    brand_id: string | null;
    workspace_id: string | null;
    role: string | null;
  };
  /** Populated on login when the user belongs to >1 org. */
  orgs?: Array<{ id: string; name: string; slug: string }>;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
}

export interface CurrentUserResponse {
  request_id: string;
  user: {
    id: string;
    email: string;
    email_verified: boolean;
    status: string;
    created_at: string;
  };
}

export interface OkResponse {
  ok: true;
  request_id: string;
}

// ── Workspace (organization) ──────────────────────────────────────────────────

export interface CreateWorkspaceRequest {
  name: string;
  slug: string;
  region_code?: string;
}

export interface WorkspaceResponse {
  id: string;
  name: string;
  slug: string;
  owner_user_id: string;
  region_code: string;
  created_at: string;
  updated_at: string;
}

// ── Brand ────────────────────────────────────────────────────────────────────

export interface CreateBrandRequest {
  /** SEC MB-1/MB-3: workspace_id is now derived server-side from the session JWT
   *  (auth.workspaceId). Do NOT send it from the client — the backend ignores any
   *  body value and uses the JWT-scoped workspace instead. Field kept as optional
   *  for backward compat with any existing callers, but MUST NOT be populated. */
  workspace_id?: string;
  display_name: string;
  domain?: string;
  /** Derived server-side from currency_code; send if known but server overrides. */
  region_code?: string;
  /** ISO 4217 currency code — bounded allowlist: INR | AED | SAR. */
  currency_code?: 'INR' | 'AED' | 'SAR';
  /** IANA timezone — bounded allowlist. */
  timezone?: 'Asia/Kolkata' | 'Asia/Dubai' | 'Asia/Riyadh';
  /** Revenue recognition definition — MA-12: 'placed' excluded. */
  revenue_definition?: 'realized' | 'delivered';
}

export interface BrandResponse {
  id: string;
  organization_id: string;
  display_name: string;
  domain: string | null;
  status: 'active' | 'archived';
  region_code: string;
  currency_code: string;
  timezone: string;
  revenue_definition: string;
  created_at: string;
  updated_at: string;
}

// ── Members ───────────────────────────────────────────────────────────────────

/** role_code values per arch plan §1 — binding */
export type RoleCode = 'owner' | 'brand_admin' | 'manager' | 'analyst';

/** UI label mapping per arch plan §1 */
export const ROLE_LABELS: Record<RoleCode, string> = {
  owner: 'Owner',
  brand_admin: 'Admin',
  manager: 'Manager',
  analyst: 'Analyst',
};

export interface MemberResponse {
  id: string;
  organization_id: string;
  brand_id: string | null;
  app_user_id: string;
  role_code: RoleCode;
  user_email: string;
  user_full_name: string;
  /** user_status reflects app_user.status — added in Slice 3 (D-8). 'suspended' means sessions revoked. */
  user_status: 'active' | 'suspended';
  created_at: string;
}

/** Pending invite returned by GET /api/v1/invites?status=pending (D-4/D-11). */
export interface InviteResponse {
  id: string;
  organization_id: string;
  brand_id: string | null;
  email: string;
  role_code: RoleCode;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: string;
  created_at: string;
  invited_by_user_id: string;
}

export interface InviteMemberRequest {
  email: string;
  role_code: RoleCode;
  brand_id?: string; // null = org-level invite
  organization_id: string;
}

export interface AcceptInviteRequest {
  token: string;
}

export interface UpdateMemberRoleRequest {
  role_code: RoleCode;
}

// ── Connector ─────────────────────────────────────────────────────────────────

export type ConnectorProvider = 'shopify';
export type ConnectorStatus = 'connected' | 'disconnected' | 'error';
export type SyncState = 'connected' | 'syncing' | 'waiting_for_data' | 'error';

export interface ConnectorListItem {
  provider: ConnectorProvider | 'meta' | 'google';
  display_name: string;
  description: string;
  coming_soon: boolean;
  /** present only when coming_soon = false and a connection exists */
  instance?: ConnectorInstanceResponse;
}

export interface ConnectorInstanceResponse {
  id: string;
  brand_id: string;
  provider: ConnectorProvider;
  shop_domain: string;
  status: ConnectorStatus;
  connected_at: string;
  disconnected_at: string | null;
  sync_state: SyncState;
  last_sync_at: string | null;
  last_error: string | null;
}

// ── Marketplace (feat-connector-marketplace B0) ───────────────────────────────
// Mirror of connector.api.v1.ts shapes — used in apps/web only (no Zod at runtime).

export type ConnectorCategory =
  | 'storefront'
  | 'ads'
  | 'payments'
  | 'logistics'
  | 'messaging'
  | 'crm'
  | 'analytics';

/** 7-state health model (ADR-CM-5 / migration 0021). */
export type HealthState =
  | 'Healthy'
  | 'Delayed'
  | 'Failed'
  | 'Disconnected'
  | 'RateLimited'
  | 'TokenExpired'
  | 'Disabled';

/** 3-state safety rating derived from health_state. */
export type SafetyRating = 'safe' | 'degraded' | 'blocked';

/** Per-instance data present only when the brand has a connector_instance. NN-2: NO secret_ref, NO token. */
export interface MarketplaceTileInstance {
  id: string;
  status: ConnectorStatus;
  health_state: HealthState;
  safety_rating: SafetyRating;
  shop_domain: string | null;
  connected_at: string | null;
}

/** One tile in the marketplace (catalog ⨝ connector_instance). */
export interface MarketplaceTile {
  id: string;
  category: ConnectorCategory;
  display_name: string;
  description: string;
  connect_method: 'oauth' | 'credential' | 'coming_soon';
  /** false = coming-soon, un-connectable (ADR-CM-2). */
  available: boolean;
  /** null = not connected yet for this brand. */
  instance: MarketplaceTileInstance | null;
}

/** Connect response discriminated union — oauth gets oauth_url, credential gets connected:true. */
export type ConnectResponseData =
  | { kind: 'oauth'; oauth_url: string }
  | { kind: 'credential'; connected: true };

export interface ShopifyInstallUrlResponse {
  install_url: string;
}

// ── Pixel ─────────────────────────────────────────────────────────────────────

export type PixelState = 'connected' | 'syncing' | 'waiting_for_data' | 'error';

/** Normalized pixel installation (GET reads, POST provisions). `installed: false`
 *  means no installation exists yet — the wizard offers to generate one. */
export interface PixelInstallationResponse {
  installed: boolean;
  installation_id?: string;
  install_token?: string;
  target_host?: string;
  snippet?: string; // The HTML snippet to embed (from snippet_html)
  is_new?: boolean;
}

export interface PixelHealthResponse {
  id: string;
  brand_id: string;
  state: PixelState;
  verified_at: string | null;
  last_error: string | null;
  updated_at: string;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
// Sources per arch plan §6.4: Postgres control-plane ONLY. No OLAP/StarRocks.

export interface DashboardBrandSummaryResponse {
  workspace_name: string;
  brand_name: string;
  member_count: number;
  /** MA-06/B2: active brand id from auth.brandId — switcher pivots on this, not array index. */
  active_brand_id: string | null;
  /** Full brand list in the active org — drives the switcher (MA-14/15). */
  brands: Array<{ id: string; display_name: string; domain: string | null; status: string }>;
}

export interface DashboardConnectionStatusResponse {
  connector_status: ConnectorStatus | null; // null = no connector yet
  sync_state: SyncState | null;
  last_sync_at: string | null;
  provider: ConnectorProvider | null;
}

export interface DashboardDataStatusResponse {
  pixel_state: PixelState | null; // null = pixel not installed
  pixel_installed_at: string | null;
}

export interface OnboardingStep {
  id: string;
  label: string;
  completed: boolean;
  route?: string;
}

export interface DashboardOnboardingResponse {
  steps: OnboardingStep[];
  all_complete: boolean;
}

// ── Realized Revenue (D-1..D-4, §4 contract) ─────────────────────────────────
// Source: analytics service → metric engine → ledger (Postgres). Never ad-hoc SUM.

/**
 * Component-facing model for the realized-revenue card.
 * Mapped from RawRealizedRevenue by dashboardApi.getRealizedRevenue().
 *
 * state:  'no_data'  — no finalized ledger rows; UI renders "No data yet" (D-2).
 *         'has_data' — at least one finalized row; realized/provisional are populated.
 *
 * realized/provisional: Record<currency_code, string> (minor-unit string from BFF bigint).
 * null only when state === 'no_data'. Never blended or summed (D-4).
 */
export interface DashboardRealizedRevenueResponse {
  state: 'no_data' | 'has_data';
  as_of: string;
  realized: Record<string, string> | null;
  provisional: Record<string, string> | null;
}

// ── Analytics (Phase 1) ───────────────────────────────────────────────────────
// All amount fields are bigint-serialized strings (D-1). Never floats.

export interface AnalyticsTimeseriesBucket {
  bucket: string;           // 'YYYY-MM-DD'
  currency_code: string;
  realized_minor: string;   // bigint string
  provisional_minor: string;// bigint string
}

export type AnalyticsTimeseriesResponse =
  | { state: 'no_data'; from: string | null; to: string | null; grain: string }
  | { state: 'has_data'; from: string; to: string; grain: string; buckets: AnalyticsTimeseriesBucket[] };

export interface AnalyticsKpiDto {
  currency_code: string;
  realized_minor: string;
  provisional_minor: string;
  order_count: string;
  aov_minor: string;
  rto_rate_pct: string;
}

export type AnalyticsKpiSummaryResponse =
  | { state: 'no_data'; as_of: string }
  | { state: 'has_data'; as_of: string; kpis: AnalyticsKpiDto[] };

export interface AnalyticsRecognitionItem {
  label: 'provisional' | 'settling' | 'finalized';
  amount_minor: string;
  count: string;
  currency_code: string;
}

export type AnalyticsRecognitionBreakdownResponse =
  | { state: 'no_data'; as_of: string }
  | { state: 'has_data'; as_of: string; breakdown: AnalyticsRecognitionItem[] };

export interface AnalyticsActivityRow {
  order_id: string;
  event_type: 'provisional_recognition' | 'finalization' | 'rto_reversal';
  amount_minor: string;
  currency_code: string;
  occurred_at: string;
  recognition_label: string | null;
}

export interface AnalyticsRecentActivityResponse {
  rows: AnalyticsActivityRow[];
}

// ── Analytics (Phase 2) ────────────────────────────────────────────────────────
// All amount/count fields are bigint-serialized strings (D-1). Never floats.

export interface AnalyticsOrdersBucket {
  bucket: string;          // 'YYYY-MM-DD'
  currency_code: string;
  order_count: string;     // bigint string
  rto_count: string;       // bigint string
  realized_minor: string;  // bigint string (minor units)
}

export type AnalyticsOrdersTimeseriesResponse =
  | { state: 'no_data'; from: string | null; to: string | null; grain: string }
  | { state: 'has_data'; from: string; to: string; grain: string; buckets: AnalyticsOrdersBucket[] };

export interface AnalyticsOrderStatsDto {
  currency_code: string;
  order_count: string;   // bigint string
  aov_minor: string;     // bigint string (minor units)
  rto_rate_pct: string;  // numeric string e.g. '3.25'
}

export type AnalyticsOrderStatsResponse =
  | { state: 'no_data'; as_of: string }
  | { state: 'has_data'; as_of: string; stats: AnalyticsOrderStatsDto[] };

export interface AnalyticsDataHealthVolumeBucket {
  bucket: string; // 'YYYY-MM-DD'
  count: string;  // bigint string
}

export type AnalyticsDataHealthResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      eventVolume: AnalyticsDataHealthVolumeBucket[];
      lastIngestAt: string | null;
      syncState: string | null;
      lastSyncAt: string | null;
    };

// ── Tracking Center (Phase 1 Track C) ──────────────────────────────────────────
// Pixel-collection health + the Event Explorer feed. NO raw PII — anonymized ids
// + aggregate counts only. All count fields are bigint-serialized strings (D-1).

export type AnalyticsTrackingHealthResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      firstEventReceived: true;
      eventVolume: AnalyticsDataHealthVolumeBucket[]; // reuse the same bucket shape
      lastEventAt: string | null;
      totalEvents: string;          // bigint string
      consentGrantedCount: string;  // bigint string
      consentTotalCount: string;    // bigint string
    };

export interface AnalyticsRecentEventRow {
  event_id: string;
  event_type: string;        // 'page.viewed' | 'cart.item_added' | ...
  occurred_at: string;       // ISO timestamp
  anon_id: string | null;    // brain_anon_id (anonymized)
  session_id: string | null; // hashed_session_id (anonymized)
  has_consent: boolean;
}

export interface AnalyticsRecentEventsResponse {
  rows: AnalyticsRecentEventRow[];
}

// ── Keyset pagination ─────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

// ── Workspace list (actual shape from GET /v1/workspaces) ─────────────────────

export interface WorkspaceListResponse {
  request_id: string;
  workspaces: WorkspaceResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

// ── Session refresh ───────────────────────────────────────────────────────────

export interface SessionRefreshResponse {
  request_id: string;
  /** Replaces needs_onboarding: boolean. null = no org membership yet. */
  onboarding_status: OnboardingStatus | null;
  auth: {
    brand_id: string | null;
    workspace_id: string | null;
    role: string | null;
  };
}

// ── BFF set-org ───────────────────────────────────────────────────────────────

export interface SetOrgRequest {
  organization_id: string;
}

export interface SetOrgResponse {
  request_id: string;
  onboarding_status: OnboardingStatus | null;
  auth: {
    brand_id: string | null;
    workspace_id: string | null;
    role: string | null;
  };
}

// ── BFF set-brand ─────────────────────────────────────────────────────────────

export interface SetBrandResponse {
  request_id: string;
  auth: {
    brand_id: string;
    workspace_id: string;
    role: string;
  };
}

// ── Onboarding advance ────────────────────────────────────────────────────────

export interface OnboardingAdvanceRequest {
  to: 'integration_selected' | 'complete';
}

export interface OnboardingAdvanceResponse {
  onboarding_status: OnboardingStatus;
}

// ── Register (with INVITE_PENDING extension) ──────────────────────────────────

export interface RegisterResponse {
  user_id: string;
  email: string;
  message: string;
  /** Backend returns this when the email has a pending invite. */
  code?: 'INVITE_PENDING';
}
