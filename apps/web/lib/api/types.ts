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
  /**
   * Authoritative wizard status (feat-onboarding-ux). Returned by /v1/bff/me so the
   * OnboardingGate can forward-redirect when the user is past the current step.
   * null = no org membership yet (fresh auto-logged-in user → /onboarding/start).
   */
  onboarding_status?: OnboardingStatus | null;
  /**
   * Active-brand session context. Returned by /v1/auth/me so useSessionRole() can gate
   * role-based UI (Sync now / backfill triggers). Without it the client fell back to the
   * most-restrictive 'analyst' and hid those controls for everyone after a refresh.
   */
  auth?: {
    role?: string | null;
    brand_id?: string | null;
    workspace_id?: string | null;
  } | null;
}

export interface OkResponse {
  ok: true;
  request_id: string;
}

// ── Workspace (organization) ──────────────────────────────────────────────────

export interface CreateWorkspaceRequest {
  name: string;
  /**
   * feat-onboarding-ux: slug is now optional — the server derives it from the name when
   * absent (additive/relaxing change, non-breaking). The slug input is no longer shown.
   */
  slug?: string;
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

// ── Ad-connectors (Slice 1 Track 3) — spend + blended ROAS ──────────────────────
// All amount fields are bigint-serialized strings (D-1). Never floats.

export interface AnalyticsAdSpendBucket {
  bucket: string;          // 'YYYY-MM-DD'
  platform: string;        // 'meta' | 'google_ads'
  currency_code: string;
  spend_minor: string;     // bigint string (minor units)
}

export type AnalyticsAdSpendTimeseriesResponse =
  | { state: 'no_data'; from: string | null; to: string | null; grain: string; platform: string | null }
  | {
      state: 'has_data';
      from: string;
      to: string;
      grain: string;
      platform: string | null;
      buckets: AnalyticsAdSpendBucket[];
    };

export interface AnalyticsBlendedRoasRow {
  currency_code: string;
  realized_minor: string;     // bigint string (minor units)
  spend_minor: string;        // bigint string (minor units)
  roas_ratio: string | null;  // exact decimal string; null when spend=0 (honest)
}

export type AnalyticsBlendedRoasResponse =
  | { state: 'no_data'; from: string; to: string }
  | { state: 'has_data'; from: string; to: string; rows: AnalyticsBlendedRoasRow[] };

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

// ── Settlements (Razorpay Track C — net-of-fees) ──────────────────────────────
//
// Settlement = realized revenue NET of Razorpay processing fees/tax/reserve/reversals.
// gross_minor / net_minor / amount_minor are bigint-serialized minor-unit strings —
// render with formatMoneyDisplay(minorString, currency_code). NEVER /100 or parseFloat.
// fees[].amount_minor is a POSITIVE magnitude (UI renders it as a "− ₹X" deduction).

export type SettlementFeeType =
  | 'payment_fee'
  | 'settlement_tax'
  | 'rolling_reserve_deduction'
  | 'settlement_reversal';

export interface SettlementFee {
  type: SettlementFeeType;
  amount_minor: string; // POSITIVE magnitude, minor units
}

/** state:'no_data' → no settlement rows yet; UI renders honest "No settlement data yet". */
export type AnalyticsSettlementsResponse =
  | { state: 'no_data'; as_of: string }
  | {
      state: 'has_data';
      as_of: string;
      currency_code: string;
      gross_minor: string; // bigint string
      net_minor: string;   // bigint string (net-of-fees)
      fees: SettlementFee[];
    };

// ── CoD / RTO surface (GoKwik + Shopflo Track C) ───────────────────────────────
//
// All amount/count fields are bigint-serialized strings (D-1). Never floats.
// data_source ('synthetic' | 'live') drives the honest "Synthetic (dev)" badge —
// GoKwik AWB/RTO data is synthetic-sourced in dev (real shape, partner sandbox is a
// platform follow-up); Shopflo checkout_abandoned is REAL. Numeric RTO score is NEVER
// fabricated — GoKwik exposes a categorical risk_flag we record verbatim.

export type DataSource = 'synthetic' | 'live';

export interface CodRtoCohort {
  pincode: string;            // destination pincode, or 'unknown'
  terminal_count: string;     // bigint string (denominator)
  rto_count: string;          // bigint string (numerator)
  rto_rate_pct: string | null;// 2dp string e.g. '12.50'; null when terminal_count=0
}

export type AnalyticsCodRtoRatesResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      overall_rto_rate_pct: string | null;
      total_terminal: string; // bigint string
      total_rto: string;      // bigint string
      cohorts: CodRtoCohort[];
      data_source: DataSource;
      pincode_pending: boolean;
    };

export type AnalyticsCodMixResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      currency_code: string;
      cod_delivered_minor: string;    // bigint string
      cod_rto_clawback_minor: string; // bigint string (POSITIVE magnitude)
      cod_net_minor: string;          // bigint string (may be negative — honest)
      prepaid_minor: string;          // bigint string
      cod_share_pct: string | null;   // 2dp string; null when denom ≤ 0
    };

export type AnalyticsCheckoutFunnelResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      currency_code: string;
      abandoned_count: string;        // bigint string
      discount_applied_count: string; // bigint string
      with_address_count: string;     // bigint string
      abandoned_value_minor: string;  // bigint string (minor units)
      data_source: DataSource;
    };

// ── Order-status mix (Silver tier — feat-silver-tier-order-state Track 3) ──────
//
// The FIRST surface read from the new Silver analytics tier (dbt → StarRocks
// silver.order_state), via the metric-engine Silver seam (I-ST01 sole read path —
// the UI NEVER queries StarRocks). order-status-mix is a NON-additive aggregation
// (COUNT + share by lifecycle_state) computed in the metric-engine (ADR-004), not dbt.
//
// All count/value fields are bigint-serialized strings (I-S07 / D-1) — never floats,
// never /100. share_pct is a 2dp string (integer-only share math in the engine) or
// null when the denominator is 0. data_source ('synthetic' | 'live') drives the
// "Synthetic (dev)" badge: in dev the underlying ledger cod_* rows are synthetic
// (real shape, synthetic source) — never presented as live.

/** Canonical order lifecycle states (derived from realized_revenue_ledger.event_type). */
export type OrderLifecycleState =
  | 'placed'
  | 'confirmed'
  | 'delivered'
  | 'cancelled'
  | 'rto'
  | 'refunded';

/** One row of the status mix — counts + share + realized value for a lifecycle state. */
export interface OrderStatusMixRow {
  lifecycle_state: OrderLifecycleState;
  count: string;          // bigint string (orders in this state)
  share_pct: string | null; // 2dp string e.g. '42.50'; null when total = 0
  value_minor: string;    // bigint string (minor units — realized order value in this state)
}

export type AnalyticsOrderStatusMixResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;            // YYYY-MM-DD (echoed range)
      to: string;              // YYYY-MM-DD
      currency_code: string;   // ISO 4217 — single brand currency (Slice 1)
      total: string;           // bigint string (total orders in range)
      terminal_count: string;  // bigint string (orders in a terminal state)
      by_state: OrderStatusMixRow[];
      data_source: DataSource;
    };

// ── Journey / first-touch (Silver tier — feat-journey-touchpoint Track 3) ──────
//
// The SECOND surface read from the Silver analytics tier (dbt → StarRocks
// silver.touchpoint), via the metric-engine journey seam (withSilverBrand, I-ST01
// sole read path — the UI NEVER queries StarRocks). All three reads are NON-additive
// aggregations / projections computed in the metric-engine (ADR-004), not dbt.
//
// All count fields are bigint-serialized strings (D-1) — never floats. share/rate
// fields are 2dp strings (integer basis-point share math in the engine) or null when
// the denominator is 0 — never a fabricated 0%. data_source ('synthetic' | 'live')
// drives the "Synthetic (dev)" badge: the 94 real page.viewed events are thin, so a
// window may be enriched with CLEARLY-LABELLED synthetic journey fixtures — never
// presented as live. There is NO money column (touchpoints are not monetary).
//
// Channel is a deterministic CASE-ladder value (click_id → paid; else utm.medium;
// else referrer → referral; else direct) — never a classifier (D-5: no ML/fuzzy).

/** Canonical first-touch channels (deterministic CASE ladder in the dbt mart). */
export type JourneyChannel =
  | 'paid'
  | 'paid_meta'
  | 'paid_google'
  | 'paid_tiktok'
  | 'email'
  | 'organic_social'
  | 'referral'
  | 'direct';

/** One row of the first-touch channel mix — count + integer-basis-point share. */
export interface FirstTouchMixRow {
  channel: JourneyChannel;
  count: string;            // bigint string (distinct journeys whose first touch is this channel)
  share_pct: string | null; // 2dp string e.g. '42.50'; null when total = 0
}

export type AnalyticsJourneyFirstTouchMixResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;             // YYYY-MM-DD (echoed range)
      to: string;               // YYYY-MM-DD
      total: string;            // bigint string (total distinct journeys in range)
      by_channel: FirstTouchMixRow[];
      // Coverage honesty: core does not split touch counts; data_source flags the whole
      // window as 'synthetic' or 'live' (the UI derives the real-vs-synthetic line from it).
      data_source: DataSource;
    };

export type AnalyticsJourneyStitchRateResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;             // YYYY-MM-DD (echoed range)
      to: string;               // YYYY-MM-DD
      stitched: string;         // bigint string (distinct anon journeys stitched to a known brain_id)
      total: string;            // bigint string (distinct anon journeys — the denominator)
      hit_pct: string | null;   // 2dp string e.g. '37.50'; null when total = 0
      data_source: DataSource;
    };

/** One ordered touch in a journey timeline (per-touch grain, touch_seq asc). */
export interface JourneyTouchpointRow {
  touch_seq: number;             // 1-based ordering within the journey
  channel: JourneyChannel;
  occurred_at: string;           // ISO timestamp (server-derived)
  is_first_touch: boolean;
  is_last_touch: boolean;
  event_type: string;            // 'page.viewed' | 'cart.viewed' | 'cart.item_added'
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  referrer_host: string | null;
  landing_path: string | null;
}

export type AnalyticsJourneyTimelineResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      order_id: string;          // echoed selector
      stitched: boolean;         // whether this order resolved to a known journey (deterministic stitch)
      touches: JourneyTouchpointRow[];
      data_source: DataSource;
    };

// ── Attribution (Phase 5 — feat-attribution-ledger Track C) ────────────────────
//
// The attributed-revenue / channel-ROAS surface. Reads the Gold attribution credit
// ledger (logical gold.attribution_credit_ledger → physical Postgres 0032) via the
// metric-engine sole read path (I-ST01 — the UI NEVER queries the ledger/StarRocks).
//
// THE INVARIANTS rendered here:
//   - Money = BIGINT minor-unit SIGNED strings + currency_code (I-S07) — never floats,
//     never /100. A clawback nets the credit, so a channel's contribution may be < the
//     gross; the net is what we render (honest).
//   - weight_fraction sums to 1.0 per order in the engine — the UI never re-apportions.
//   - The CLOSED-SUM PARITY ORACLE is visibly rendered: Σ channel_contribution_minor +
//     unattributed_minor = realized_gmv_minor. The residual (unattributed) is ALWAYS
//     shown alongside — never hidden, never silently spread (METRICS.md §Rules).
//   - attribution_reconciliation_rate = attributed ÷ realized × 100 (2dp string from the
//     engine — never re-divided with floats in the client).
//   - Channel ROAS = attributed_revenue ÷ ad_spend (joins ad_spend_ledger); honest null
//     when spend = 0 (no fabricated infinity). Same-currency only (like blended_roas).
//   - attribution_confidence grade (strong/partial/weak) stamped at credit time, carried
//     verbatim — a deterministic floor over journey signal (NOT a model number).
//
// data_source ('synthetic' | 'live') drives the honest "Synthetic (dev)" badge: real
// journey data is thin (23 real touchpoints) so dev attribution is mostly synthetic —
// NEVER presented as live.

/** The 4 deterministic attribution models (position_based is the default). */
export type AttributionModel =
  | 'first_touch'
  | 'last_touch'
  | 'linear'
  | 'position_based';

/** Deterministic attribution-confidence grade (a floor over journey signal — NOT a model). */
export type AttributionConfidenceGrade = 'strong' | 'partial' | 'weak';

/** One channel's attributed contribution for the selected model + window.
 *  Mirrors core ChannelContributionDto ({channel, currency_code, contribution_minor}).
 *  share_pct / confidence_grade are OPTIONAL — core's by-channel response does not emit
 *  them today; the UI guards for their absence (they light up if core adds per-channel
 *  share/grade later). */
export interface AttributedChannelRow {
  channel: JourneyChannel;
  currency_code: string;
  /** SIGNED bigint string (minor units) — net of clawbacks. May be < gross, never floats. */
  contribution_minor: string;
  /** 2dp share string of the attributed total; absent until core emits it. */
  share_pct?: string | null;
  /** Deterministic confidence grade for this channel's credited touches; absent until core emits it. */
  confidence_grade?: AttributionConfidenceGrade;
}

// Field names mirror the core BFF response (get-attribution-by-channel): attributed_gmv_minor /
// realized_gmv_minor / unattributed_minor / reconciliation_rate_pct / by_channel.
export type AnalyticsAttributionByChannelResponse =
  | { state: 'no_data'; from: string; to: string; model: AttributionModel }
  | {
      state: 'has_data';
      from: string; // YYYY-MM-DD (echoed range)
      to: string;
      model: AttributionModel;
      currency_code: string; // ISO 4217 — single brand currency, always present in has_data
      /** SIGNED bigint string — Σ channel_contribution_minor (attributed total, net). */
      attributed_gmv_minor: string;
      /** SIGNED bigint string — realized GMV basis (the closed-sum total). */
      realized_gmv_minor: string;
      /** SIGNED bigint string — realized − attributed (the unattributed residual). */
      unattributed_minor: string;
      /** 2dp string — attributed ÷ realized × 100; null when realized = 0 (honest). */
      reconciliation_rate_pct: string | null;
      by_channel: AttributedChannelRow[];
      data_source: DataSource;
    };

/**
 * The reconciliation residual — the CLOSED-SUM PARITY ORACLE made visible.
 * realized_gmv_minor = attributed_gmv_minor + unattributed_minor (exact, tolerance 0).
 */
export type AnalyticsAttributionReconciliationResponse =
  | { state: 'no_data'; from: string; to: string; model: AttributionModel }
  | {
      state: 'has_data';
      from: string;
      to: string;
      model: AttributionModel;
      currency_code: string; // ISO 4217 — always present in has_data
      /** SIGNED bigint string — realized GMV basis (the closed-sum total). */
      realized_gmv_minor: string;
      /** SIGNED bigint string — Σ channel_contribution_minor (attributed, net of clawbacks). */
      attributed_gmv_minor: string;
      /** SIGNED bigint string — realized − attributed (the unattributed residual; always rendered). */
      unattributed_minor: string;
      /** 2dp string — attributed ÷ realized × 100; null when realized = 0 (honest). */
      reconciliation_rate_pct: string | null;
      data_source: DataSource;
    };

/** One channel's unit economics — attributed revenue ÷ ad spend. */
export interface ChannelRoasRow {
  channel: JourneyChannel;
  currency_code: string;
  /** SIGNED bigint string (minor units) — attributed revenue, net of clawbacks. */
  attributed_minor: string;
  /** bigint string (minor units) — ad spend for the channel (from ad_spend_ledger). */
  spend_minor: string;
  /** Exact decimal string (attributed ÷ spend); null when spend = 0 (honest — no infinity). */
  roas_ratio: string | null;
}

export type AnalyticsChannelRoasResponse =
  | { state: 'no_data'; from: string; to: string; model: AttributionModel }
  | {
      state: 'has_data';
      from: string;
      to: string;
      model: AttributionModel;
      currency_code: string;
      rows: ChannelRoasRow[];
      data_source: DataSource;
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

// ── Consent / Compliance (D13 — feat-d13-consent-cancontact Track C) ────────────
//
// The per-brand consent/compliance surface (/settings/consent). The web app reads
// ONLY via the BFF (/api/v1/consent/*). NO raw PII — these are aggregate COUNTS +
// decision metadata + a fixed regulatory window. All count fields are bigint-serialized
// strings (D-1) — never floats, never re-divided in the client.
//
// FAIL-CLOSED: an empty consent system-of-record is state:'no_data' — for consent that
// means "blocked by default" (nothing is sendable until consent is recorded), NOT a
// fabricated allow. The UI renders the default-closed posture explicitly.

/** The 4 DPDP lawful-basis consent categories (mirrors the contract + DB CHECK). */
export type ConsentCategory =
  | 'analytics'
  | 'marketing'
  | 'personalization'
  | 'ai_processing';

/** One category row of the coverage panel — granted vs withdrawn subject counts. */
export interface ConsentCoverageRow {
  category: ConsentCategory;
  granted: string;   // bigint string (subjects whose latest state is granted)
  withdrawn: string; // bigint string (subjects withdrawn or tombstoned)
}

export type ConsentCoverageResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      by_category: ConsentCoverageRow[];
      total_subjects: string; // bigint string
    };

export type ConsentSuppressionSummaryResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      suppressed_subjects: string; // bigint string — suppressed for marketing
      tombstoned_subjects: string; // bigint string
      granted_subjects: string;    // bigint string — marketing-granted & not tombstoned
    };

/** A single can_contact() gate decision (from audit_log) — never carries raw recipient. */
export type ConsentGateDecision = 'allow' | 'block' | 'queue_pending_window';

export interface ConsentGateActivityRow {
  decision: ConsentGateDecision;
  reason: string;          // 'consent_absent' | 'dlt_unregistered' | 'out_of_window' | …
  channel: string | null;  // 'marketing_email' | 'whatsapp' | …
  purpose: string | null;  // 'marketing' | 'transactional'
  occurred_at: string;     // ISO timestamp
}

export type ConsentGateActivityResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      decisions: ConsentGateActivityRow[];
      allow_count: string; // bigint string
      block_count: string;
      queue_count: string;
    };

/** The read-only, SERVER-enforced 9–9 IST permitted-hours send window. */
export interface ConsentWindowConfigResponse {
  timezone: string;        // 'Asia/Kolkata'
  window_start: string;    // '09:00'
  window_end: string;      // '21:00'
  in_window_now: boolean;  // server-computed (UI never derives from a client clock)
  next_window_open: string; // ISO ts of the next 09:00 IST boundary
  enforced: 'server';
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
  /**
   * feat-onboarding-ux: the BFF /v1/bff/register auto-login path sets the httpOnly
   * `brain_session` cookie for a genuinely-new user and reports `created: true`. The
   * JSON body stays byte-identical for the existing-user collision case (created:false,
   * no cookie) to avoid an enumeration oracle. When true, the user is already
   * authenticated and the client routes straight into the wizard (no /login detour).
   */
  created?: boolean;
}

// ── Onboarding provision (merged workspace+brand — feat-onboarding-ux) ─────────

export interface ProvisionOnboardingRequest {
  workspace_name: string;
  brand_display_name: string;
  /** Optional brand website — powers the per-brand tracking pixel (server normalizes). */
  domain?: string;
  currency_code?: 'INR' | 'AED' | 'SAR';
  timezone?: 'Asia/Kolkata' | 'Asia/Dubai' | 'Asia/Riyadh';
  revenue_definition?: 'realized' | 'delivered';
}

export interface ProvisionOnboardingResponse {
  request_id: string;
  organization_id: string;
  brand_id: string;
  /** True when the website was captured and a pixel was provisioned (drives ?w=1). */
  website_provided: boolean;
  onboarding_status: OnboardingStatus | null;
}
