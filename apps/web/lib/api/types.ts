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

export interface RegisterResponse {
  user_id: string;
  email: string;
  message: string; // "Check your email to verify your account"
}

export interface VerifyEmailRequest {
  token: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user_id: string;
  email: string;
  full_name: string;
  // Access JWT is set as httpOnly cookie by the BFF; not in body
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
}

export interface CurrentUserResponse {
  user_id: string;
  email: string;
  full_name: string;
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
  organization_id: string;
  display_name: string;
  domain?: string;
  region_code?: string;
}

export interface BrandResponse {
  id: string;
  organization_id: string;
  display_name: string;
  domain: string | null;
  status: 'active' | 'archived';
  region_code: string;
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

export interface PixelInstallationResponse {
  id: string;
  brand_id: string;
  install_token: string;
  target_host: string;
  installed_at: string | null;
  snippet: string; // The HTML snippet to embed
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
