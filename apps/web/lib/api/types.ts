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
  created_at: string;
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
