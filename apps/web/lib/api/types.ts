/**
 * M1 API types.
 *
 * The drift-prone analytics/dashboard/data-quality/ask READ DTOs are now DERIVED from the
 * Zod single-source-of-truth in `@brain/contracts` (feat-shared-bff-read-contracts). Those
 * covered surfaces are RE-EXPORTED below under their existing web alias names (so consuming
 * components compile unchanged) — they are NOT hand-redeclared here anymore. The runtime
 * `schema.parse()` boundary lives in `client.ts` (parseData), so a core<->web field mismatch
 * throws a CLEAR field-named error at the seam instead of a deep `BigInt(undefined)`.
 *
 * Un-migrated DTOs below are still hand-declared (incremental).
 */

// -- Covered BFF read DTOs -- DERIVED from @brain/contracts (single source of truth) --
// Re-exported under existing web alias names so components compile unchanged.
export type {
  RevenueSnapshot as DashboardRealizedRevenueResponse,
  KpiSummaryDto as AnalyticsKpiDto,
  KpiSummary as AnalyticsKpiSummaryResponse,
  AttributionReconciliation as AnalyticsAttributionReconciliationResponse,
  ChannelRoasDto as ChannelRoasRow,
  ChannelRoas as AnalyticsChannelRoasResponse,
  FirstTouchMixRowDto as FirstTouchMixRow,
  JourneyFirstTouchMix as AnalyticsJourneyFirstTouchMixResponse,
  TimelineTouchDto as JourneyTouchpointRow,
  JourneyTimeline as AnalyticsJourneyTimelineResponse,
  JourneyStitchRate as AnalyticsJourneyStitchRateResponse,
  ShipmentOutcomes as AnalyticsShipmentOutcomesResponse,
  CourierOutcomeDto as ShipmentCourierRow,
  PincodeOutcomeDto as ShipmentPincodeRow,
  ReturnFunnel as AnalyticsReturnFunnelResponse,
  ReturnClassBucketDto as ReturnClassRow,
  ReturnCourierBucketDto as ReturnCourierRow,
  BehaviorOverview as AnalyticsBehaviorOverviewResponse,
  PageTypeBucketDto as BehaviorPageTypeRow,
  BrowsedItemDto as BehaviorBrowsedItemRow,
  FunnelAnalytics as AnalyticsFunnelResponse,
  FunnelStageDto as FunnelStageRow,
  AbandonedCart as AnalyticsAbandonedCartResponse,
  Engagement as AnalyticsEngagementResponse,
  OrderStatusMixRowDto as OrderStatusMixRow,
  OrderStatusMix as AnalyticsOrderStatusMixResponse,
  TopProducts as AnalyticsTopProductsResponse,
  TopProductDto,
  OrdersList as AnalyticsOrdersListResponse,
  OrderListItemDto,
  ContributionMargin as AnalyticsContributionMarginResponse,
  ContributionMarginDto,
  CostInputsList as AnalyticsCostInputsResponse,
  CostInputDto,
  OrderDetail as AnalyticsOrderDetailResponse,
  OrderDetailDto,
  OrderLineItemDto,
  OrderTaxLineDto,
  OrderDiscountCodeDto,
  OrderRefundDto,
  DqGradeRow as DqGradeCell,
  DataQualitySummary as DataQualitySummaryResponse,
  AskBrainBinding as AskBinding,
  ComputedNumber as AskComputedNumber,
  AskBrainResult as AskBrainResponse,
  JourneyChannel,
  LifecycleState as OrderLifecycleState,
  Customer360 as Customer360Response,
  Customer360Profile,
  Customer360Identifier,
  Customer360Merge,
  CustomerList as CustomerListResponse,
  CustomerListItem,
  VaultCoverage as VaultCoverageResponse,
  ErasureResult as ErasureResultResponse,
  MergeReview,
  MergeReviewList as MergeReviewListResponse,
  MergeResolveResult as MergeResolveResultResponse,
  UnmergeResult as UnmergeResultResponse,
  BillingPeriods as BillingPeriodsResponse,
  BillingPeriod,
  SealPeriodResult as SealPeriodResultResponse,
  InspectableBill as InspectableBillResponse,
  BillLine,
  Invoice as InvoiceResponse,
  InvoiceLine,
  CreditNote,
  IssueInvoiceResult as IssueInvoiceResultResponse,
  IssueCreditNoteResult as IssueCreditNoteResultResponse,
  Recommendations as RecommendationsResponse,
  Recommendation,
  GenerateRecommendationsResult as GenerateRecommendationsResultResponse,
  RecommendationAction as RecommendationActionResponse,
  RecommendationActionKind,
  Model as MlModel,
  ModelList as MlModelListResponse,
  ModelStage as MlModelStage,
  CustomerScoreResult as MlCustomerScoreResponse,
  ServedScore as MlServedScore,
  ServingModel as MlServingModel,
  FoundationHealth as FoundationHealthResponse,
  FoundationStep,
  FoundationTier,
  Entitlements as EntitlementsResponse,
  EntitlementEntry,
} from '@brain/contracts';

// Local import for the names referenced WITHIN this file (re-exports above are not in local scope).
import type {
  ChannelContributionDto,
  AttributionModelId as AttributionModel,
} from '@brain/contracts';
export type { ChannelContributionDto, AttributionModel };

// Re-export the contract Schemas the client boundary parses against.
export {
  RevenueSnapshotSchema,
  KpiSummarySchema,
  AttributionByChannelSchema,
  AttributionReconciliationSchema,
  ChannelRoasSchema,
  JourneyFirstTouchMixSchema,
  JourneyTimelineSchema,
  JourneyStitchRateSchema,
  ShipmentOutcomesSchema,
  ReturnFunnelSchema,
  BehaviorOverviewSchema,
  OrderStatusMixSchema,
  DataQualitySummarySchema,
  AskBrainResultSchema,
} from '@brain/contracts';

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
  /** ISO 4217 currency code — supported brand-primary allowlist: GCC + India. */
  currency_code?: 'INR' | 'AED' | 'SAR' | 'QAR' | 'KWD' | 'BHD' | 'OMR';
  /** IANA timezone — bounded allowlist (GCC + India). */
  timezone?:
    | 'Asia/Kolkata' | 'Asia/Dubai' | 'Asia/Riyadh' | 'Asia/Kuwait' | 'Asia/Bahrain' | 'Asia/Muscat' | 'Asia/Qatar';
  /** Revenue recognition definition — MA-12: 'placed' excluded. */
  revenue_definition?: 'realized' | 'delivered';
}

/** Brand lifecycle status — 'archived' = soft-deleted (drops out of default lists, ingest stops). */
export type BrandStatus = 'active' | 'archived';

export interface BrandResponse {
  id: string;
  organization_id: string;
  display_name: string;
  domain: string | null;
  status: BrandStatus;
  region_code: string;
  currency_code: string;
  timezone: string;
  revenue_definition: string;
  created_at: string;
  updated_at: string;
}

/**
 * One brand entry on the dashboard brand-summary (and the brand switcher). Carries `status`
 * so the switcher can filter active vs archived without a second fetch. Mirrors the BFF
 * brand-summary `brands[]` shape — the server is authoritative for `status`.
 */
export interface BrandSummaryEntry {
  id: string;
  display_name: string;
  domain: string | null;
  status: BrandStatus;
}

/** DELETE /api/v1/brands/:id → soft-delete (archive). Reversible server-side. */
export interface BrandArchiveResponse {
  id: string;
  archived: boolean;
}

/** Restore (un-archive) a previously soft-deleted brand → POST /api/v1/brands/:id/restore. */
export interface BrandRestoreResponse {
  id: string;
  /** false once the brand is active again. */
  archived: boolean;
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
  /** Connector category from the marketplace catalog — drives grouped/filtered rendering. */
  category: ConnectorCategory;
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
  /** Per-account key within provider (Gap B — multi-account-per-provider, migration 0092). */
  account_key: string;
  /** Human name for this account (e.g. Meta ad-account name), captured at connect. Null = show account_key. */
  account_label?: string | null;
  /** Ad-account activation (0106). When this account was chosen to ingest; null = not chosen. */
  activated_at?: string | null;
  /** This is the active (ingesting) account. Always true for non-ad providers. */
  is_active?: boolean;
  /** Ad platform whose account has not been picked yet → UI prompts for a selection. */
  requires_activation?: boolean;
}

/**
 * One declarative auth/credential field for a connector's connect form (server-supplied — the
 * connector catalog is the single source of truth). `secret` fields render masked and are never
 * echoed back. Mirrors apps/core ConnectorAuthField over the wire.
 */
export interface ConnectorAuthFieldDto {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url';
  secret: boolean;
  optional: boolean;
  hint: string | null;
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
  /** The credential/auth fields the connect form renders (single SoR — the server catalog). */
  auth_fields?: ConnectorAuthFieldDto[];
  /** null = not connected yet for this brand. Back-compat: first active instance. */
  instance: MarketplaceTileInstance | null;
  /** All active instances for this provider (Gap B — multi-account). Empty = not connected. */
  instances: MarketplaceTileInstance[];
}

/**
 * Per-tenant inbound-webhook setup returned ONCE on a credential connect when Brain minted the
 * webhook token (SR-2 — Shiprocket). The merchant pastes `url`, the routing header, and `api_key`
 * into their provider dashboard. `api_key` is shown once (write-only in the secret bundle after).
 */
export interface ConnectWebhookSetup {
  url: string;
  api_key: string | null;
  routing_header: { name: string; value: string } | null;
}

/** Connect response discriminated union — oauth gets oauth_url, credential gets connected:true. */
export type ConnectResponseData =
  | { kind: 'oauth'; oauth_url: string }
  | {
      kind: 'credential';
      connected: true;
      connector_instance_id?: string;
      /** Present only when the connector minted a webhook token at connect-time (SR-2). */
      webhook?: ConnectWebhookSetup;
    };

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
  custom_ingest_host?: string | null; // First-party CNAME ingest host, or null for the default
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
  /** Full brand list in the active org — drives the switcher (MA-14/15). Each carries `status`
   *  so the switcher can filter active vs archived. */
  brands: BrandSummaryEntry[];
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

export interface AnalyticsRecognitionItem {
  label: 'provisional' | 'settling' | 'finalized';
  amount_minor: string;
  count: string;
  currency_code: string;
}

export type AnalyticsRecognitionBreakdownResponse =
  | { state: 'no_data'; as_of: string }
  | { state: 'has_data'; as_of: string; breakdown: AnalyticsRecognitionItem[] };

/**
 * Per-month revenue-lifecycle row from the Gold monthly mart (gold_revenue_analytics).
 * All amount/count fields are bigint-serialized strings (D-1). Money is minor units
 * + currency_code; rows are never blended across currencies.
 */
export interface AnalyticsRevenueMonthlyRow {
  period_month: string;          // 'YYYY-MM'
  lifecycle_state: string;       // placed | confirmed | cancelled | ...
  currency_code: string;
  order_count: string;           // bigint string
  realized_value_minor: string;  // bigint string (minor units)
  terminal_order_count: string;  // bigint string
}

export type AnalyticsRevenueMonthlyResponse =
  | { state: 'no_data' }
  | { state: 'has_data'; rows: AnalyticsRevenueMonthlyRow[] };

/**
 * Realized-revenue ledger event types surfaced in the activity feed. This is the
 * FULL set the ledger emits (provisional/final/RTO plus COD-settlement + fee/tax
 * rows) — kept as an open `string` union via the trailing `(string & {})` so a new
 * ledger event_type added server-side never crashes the UI (the renderer falls back
 * to a neutral config for any value not explicitly styled).
 */
export type LedgerEventType =
  | 'provisional_recognition'
  | 'finalization'
  | 'rto_reversal'
  | 'cod_delivery_confirmed'
  | 'cod_rto_clawback'
  | 'refund'
  | 'payment_fee'
  | 'settlement_finalization'
  | 'settlement_tax'
  // `string & {}` is the deliberate "open union" trick: it keeps the literal
  // autocomplete above while still accepting any forward-added server event_type.
  // NOTE: the original `// eslint-disable-next-line @typescript-eslint/ban-types`
  // directive was REMOVED — this repo's flat ESLint config does not load
  // @typescript-eslint/eslint-plugin, so naming that rule errored as "rule not
  // found", and a plain disable became an "unused directive" warning. With no
  // ban-types rule active there is nothing to suppress.
  | (string & {});

export interface AnalyticsActivityRow {
  order_id: string;
  event_type: LedgerEventType;
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
      /** FX convenience view (display-only): spend blended to the brand's primary currency. */
      primary_currency?: string | null;
      total_spend_in_primary_minor?: string | null;
      meta_spend_in_primary_minor?: string | null;
      google_spend_in_primary_minor?: string | null;
    };

export interface AnalyticsBlendedRoasRow {
  currency_code: string;
  realized_minor: string;     // bigint string (minor units)
  spend_minor: string;        // bigint string (minor units)
  roas_ratio: string | null;  // exact decimal string; null when spend=0 (honest)
}

export type AnalyticsBlendedRoasResponse =
  | { state: 'no_data'; from: string; to: string }
  | {
      state: 'has_data';
      from: string;
      to: string;
      rows: AnalyticsBlendedRoasRow[];
      /** FX convenience view (display-only): a single blended ROAS in the brand's primary currency. */
      primary_currency?: string | null;
      spend_in_primary_minor?: string | null;
      realized_in_primary_minor?: string | null;
      roas_in_primary?: string | null;
    };

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

// ── Data Quality (Phase 7 — dq grades + effective_confidence gate) ────────────
//
// CONTRACT SOURCE OF TRUTH (do NOT hand-guess — see arch §2c / §3):
//   apps/core/src/modules/data-quality/internal/application/queries/get-data-quality-summary.ts
//   → getDataQualitySummary(brandId, deps): Promise<DataQualitySummaryResult>
//   BFF: GET /api/v1/data-quality/summary → { request_id, data: DataQualitySummaryResult }
//
// Field names MUST match the core DTO EXACTLY (camelCase, mirroring DataHealthResult).
// This summary carries GRADES, not money — there are intentionally NO *_minor fields.
// If a *_minor field ever appears here, the core DTO has drifted: STOP and reconcile,
// never add a `/100` or parseFloat (the recurring BigInt(undefined) crash class).

/** Frozen letter grade — mirrors metric-engine DqLetterGrade (A+ > A > B > C > D). */
export type DqLetterGrade = 'A+' | 'A' | 'B' | 'C' | 'D';

/** The DQ check categories (the 4 executors). */
export type DqCheckCategory =
  | 'freshness'
  | 'completeness'
  | 'schema_validity'
  | 'reconciliation';

/** Trust tier the quality gate emits from effective_confidence. */
export type DqTrustTier = 'trusted' | 'estimated' | 'untrusted';

/**
 * Freshness-SLA status — derived server-side from the latest freshness check's
 * `passing` + how close `observed` is to `threshold`. Never colour-only in the UI.
 */
export type DqFreshnessSlaStatus = 'green' | 'at_risk' | 'breached';

/** DqGradeCell is DERIVED from @brain/contracts DqGradeRow (re-exported at top of file). */
/** The gate decision the metric-engine computes from effective_confidence. */
export interface DqGateDecision {
  tier: DqTrustTier;
  billingCapApplies: boolean;
  includedInMmm: boolean;
  blocksHighRiskRecommendation: boolean;
}

/** dq_grade coverage — the Phase-7 success metric. */
export interface DqCoverage {
  graded: number; // distinct (category,target) with a grade
  expected: number; // distinct (category,target) expected to be graded
}

// DataQualitySummaryResponse is DERIVED from @brain/contracts DataQualitySummary
// (re-exported at top of file). The contract superset adds costConfidence /
// attributionConfidence / tier — additive, components compile unchanged.

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

// ── Cohort retention (H9/H11 — acquisition-cohort curve from gold_cohorts) ──
// Mirrors apps/core get-cohort-retention.ts (CohortRetentionDto, /v1/analytics/cohort-retention).
// One row per acquisition cohort-month: size, lifetime orders + realized value, and orders-per-
// customer (the repeat signal). Money + counts are bigint strings; orders_per_customer is an exact
// decimal string from the engine, or null when the cohort is empty (never a fabricated 0).
export interface AnalyticsCohortRetentionRow {
  cohort_month: string;                // 'YYYY-MM'
  currency_code: string;
  cohort_size: string;                 // bigint string — new customers acquired that month
  cohort_orders: string;               // bigint string — lifetime orders by that cohort
  cohort_value_minor: string;          // bigint string — lifetime realized value (minor units)
  orders_per_customer: string | null;  // exact decimal string; null when size = 0
}

export type AnalyticsCohortRetentionResponse =
  | { state: 'no_data'; generated_at?: string }
  | { state: 'has_data'; cohorts: AnalyticsCohortRetentionRow[]; generated_at?: string };

// ── RTO-risk distribution (GoKwik RTO-Predict — gokwik.rto_predict.v1 Bronze) ──
// Per-order RTO risk, counted by each order's LATEST prediction over 30d. Categorical
// risk_flag buckets (VERBATIM — never a fabricated score). Honest no_data; synthetic badge
// when data_source='synthetic' (GoKwik read API is a documented follow-up).
export type AnalyticsRtoRiskResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      order_count: string; // bigint string (distinct orders)
      high: string;
      medium: string;
      low: string;
      control: string;
      unknown: string;
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

/** Deterministic attribution-confidence grade (a floor over journey signal — NOT a model). */
export type AttributionConfidenceGrade = 'strong' | 'partial' | 'weak';

/** One channel's attributed contribution for the selected model + window.
 *  The base shape is DERIVED from @brain/contracts ChannelContributionDto (the validated,
 *  single-source-of-truth core shape: {channel, currency_code, contribution_minor}).
 *  share_pct / confidence_grade are UI-ONLY OPTIONAL additions — core's by-channel response
 *  does not emit them today; the UI guards for their absence (they light up if core adds
 *  per-channel share/grade later). The contract schema validates the core fields at the seam. */
export type AttributedChannelRow = ChannelContributionDto & {
  /** 2dp share string of the attributed total; absent until core emits it. */
  share_pct?: string | null;
  /** Deterministic confidence grade for this channel's credited touches; absent until core emits it. */
  confidence_grade?: AttributionConfidenceGrade;
};

// Field names mirror the core BFF response (get-attribution-by-channel): attributed_gmv_minor /
// realized_gmv_minor / unattributed_minor / reconciliation_rate_pct / by_channel.
export type AnalyticsAttributionByChannelResponse =
  | { state: 'no_data'; from: string; to: string; model: AttributionModel }
  // Realized revenue exists but the attribution_credit_ledger is empty — the credit pipeline
  // hasn't populated. Rendered as "not computed", never as a real 0%/100% result (audit R-10).
  | { state: 'not_computed'; from: string; to: string; model: AttributionModel }
  | {
      state: 'has_data';
      from: string; // YYYY-MM-DD (echoed range)
      to: string;
      model: AttributionModel;
      currency_code: string | null; // ISO 4217 — null when brand has no ledger rows (metric engine)
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
      clientDroppedCount: string;   // bigint string — pixel.dropped sum (client-side queue-overflow loss); 0 = none
    };

export interface AnalyticsRecentEventRow {
  event_id: string;
  event_type: string;        // 'page.viewed' | 'cart.item_added' | ... (pixel events only)
  occurred_at: string;       // ISO timestamp
  anon_id: string | null;    // brain_anon_id (anonymized)
  session_id: string | null; // hashed_session_id (anonymized)
  has_consent: boolean;
  details: Record<string, string>; // PII-safe per-event properties (page path, value, step, …)
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

// ── Conversion-Feedback / CAPI (Phase 6 — feat-capi-conversion-feedback Track C) ──────
//
// Read-only types for the stakeholder-visible Conversion-Feedback surface
// (/analytics/conversion-feedback). These MIRROR core's BFF DTO field-for-field
// (apps/core/.../get-capi-feedback.ts): bigint counts are strings; money is
// value_minor (bigint string) + currency_code (formatted minor→major at render). The
// blocked_by_consent count is the SLO=0 (non_consented_sends) made VISIBLE; the
// would_send_dev count + dev_boundary flag drive the honest "would-send in dev" banner.
// NO raw PII / no subject_hash — only counts + a truncated event_id (sha256, never PII).

/** Passback log status (mirrors the 0034 CHECK constraint). */
export type CapiPassbackStatus =
  | 'sent'
  | 'blocked_no_consent'
  | 'would_send_dev'
  | 'deleted'
  | 'failed';

/** Deletion log status (mirrors the 0034 CHECK constraint). */
export type CapiDeletionStatus = 'requested' | 'deleted' | 'would_delete_dev' | 'failed';

/** Summary band — passed-back vs blocked-by-consent + match-quality + dev boundary. */
export type CapiFeedbackSummaryResponse =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      platform: 'meta';
      passed_back: string;        // bigint string — sent + would_send_dev
      sent: string;               // bigint string — REAL live sends (0 in dev; never faked)
      would_send_dev: string;     // bigint string — matched & gated but not sent (no creds)
      blocked_by_consent: string; // bigint string — the SLO=0 made visible
      deleted: string;            // bigint string — rows superseded by retroactive deletion
      failed: string;             // bigint string — real send error (prod only)
      deletion_requests: string;  // bigint string — capi_deletion_log row count
      match_quality_pct: number | null; // 0..100 two-dp; null when nothing passed back
      avg_match_keys: number | null;    // 0..4 one-dp; null when nothing passed back
      dev_boundary: boolean;      // TRUE when any row is 'would_send_dev'
    };

/** One passback event row (truncated event_id — NEVER PII, no subject_hash). */
export interface CapiFeedbackEventRow {
  event_id_short: string;       // first 12 hex of the deterministic sha256 event_id
  status: CapiPassbackStatus;
  block_reason: string | null;  // can_contact() reason when blocked (e.g. 'consent_absent')
  match_key_count: number;      // 0..4 — Meta match keys present (em/ph/fbc/fbp)
  value_minor: string;          // bigint string (I-S07) — formatted minor→major at render
  currency_code: string;        // 'INR' | 'AED' | 'SAR'
  occurred_at: string;          // ISO timestamp (order occurred_at / event_time)
  recorded_at: string;          // ISO timestamp (when the passback decision was logged)
}

export type CapiFeedbackEventsResponse =
  | { state: 'no_data' }
  | { state: 'has_data'; events: CapiFeedbackEventRow[] };

/** One retroactive-deletion request row (no subject_hash — the consent key never leaves). */
export interface CapiFeedbackDeletionRow {
  status: CapiDeletionStatus;
  event_count: number;          // prior passback events targeted by this deletion
  requested_at: string;         // ISO timestamp
  completed_at: string | null;  // ISO timestamp; null until completed
  latency_seconds: number | null; // requested→completed seconds; null if pending
}

export type CapiFeedbackDeletionsResponse =
  | { state: 'no_data' }
  | { state: 'has_data'; deletions: CapiFeedbackDeletionRow[] };

// ── Ask Brain / Decision-Intelligence (Phase 8 — feat-decision-intelligence-inputs Track C) ──────
//
// CONTRACT SOURCE OF TRUTH (READ, do NOT hand-guess — this MIRRORS the ACTUAL core DTO):
//   apps/core/src/modules/ai/internal/ask-brain.ts → AskBrainResult (Track B)
//   BFF: POST /api/v1/ask → reply.send({ request_id, data: AskBrainResult }) (bff.routes.ts:1272)
//
// Field names are aligned EXACTLY to AskBrainResult to avoid the recurring BigInt(undefined) /
// undefined contract-drift crash (tsc + next-build do NOT catch web↔core field drift). Notably:
//   - kind is ONLY 'answer' | 'refusal' (NO top-level 'no_data' kind). Honest-empty is carried
//     INSIDE the answer via number.no_data === true (the binding resolved, but no data exists).
//   - the certified figure is `number: ComputedNumber` (NOT `value`); it is
//     { figure_kind: 'money' | 'none', money: Record<ccy,string> | null, no_data: boolean }.
//   - snapshot_id lives INSIDE `binding` (AskBrainBinding), not at the top level.
//   - trust_tier is CAPITALIZED 'Trusted' | 'Estimated' | 'Untrusted' (core's toTrustTier()).
//   - an answer also carries `provenance_id` (the appended ai_provenance row id).
//
// THE HONESTY GUARANTEE rendered here (requirement §6): the model NEVER produces a number and
// NEVER emits SQL — it resolves the question to a registry binding (metric_id + version); the
// metric-engine computes the number deterministically (I-ST01); the UI NEVER queries metric
// tables. A refusal shows NO number. number.figure_kind==='none' = a valid binding whose figure
// path is not wired yet (honest — no fabricated number).
//
// MONEY (I-S07 / D-1): `number.money` is Record<currency_code, string> — bigint minor-unit
// STRINGS, never floats, never /100. Render with formatMoneyDisplay(minorString, currency_code).
// If a `value`/`*_minor` scalar or a float ever appears here the core DTO has DRIFTED: STOP and
// reconcile — never add a `/100` or BigInt(undefined).

/** Registry metric ids — mirrors metric-engine MetricId (the 16 ids, the binding enum). */
export type AskMetricId =
  | 'realized_revenue'
  | 'provisional_revenue'
  | 'ad_spend'
  | 'blended_roas'
  | 'cod_rto_rate'
  | 'cod_mix'
  | 'checkout_funnel'
  | 'order_status_mix'
  | 'journey_first_touch_mix'
  | 'journey_stitch_rate'
  | 'journey_timeline'
  | 'attribution_credit'
  | 'attribution_reconciliation_rate'
  | 'attribution_confidence'
  | 'cost_confidence'
  | 'effective_confidence';

/** Trust tier — mirrors core TrustTier (CAPITALIZED, driving the banner; never colour-only). */
export type AskTrustTier = 'Trusted' | 'Estimated' | 'Untrusted';

/** Confidence grade — mirrors core ConfidenceGrade / DqLetterGrade (frozen letter, never a float). */
export type AskConfidenceGrade = 'A+' | 'A' | 'B' | 'C' | 'D';

/**
 * AskBrainResponse — the BFF `data` payload (mirrors core AskBrainResult EXACTLY).
 *
 * DISCRIMINATED by `kind`:
 *   - 'answer'  → binding (+ snapshot_id) + number (ComputedNumber) + confidence/tier + provenance_id.
 *                 Honest-empty is number.no_data===true; not-wired is number.figure_kind==='none'.
 *   - 'refusal' → off-domain / unresolvable; NO binding, NO number ("no certified metric…").
 */
export interface AskBrainRequest {
  /** The natural-language question. Sent in-memory only; the server persists REDACTED only. */
  question: string;
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
  currency_code?: 'INR' | 'AED' | 'SAR' | 'QAR' | 'KWD' | 'BHD' | 'OMR';
  timezone?:
    | 'Asia/Kolkata' | 'Asia/Dubai' | 'Asia/Riyadh' | 'Asia/Kuwait' | 'Asia/Bahrain' | 'Asia/Muscat' | 'Asia/Qatar';
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

// ── Executive metrics (H9 — headline AOV/LTV/repeat_rate/CAC/ROAS over the Gold marts) ──
// Surfaced from the registry-backed /v1/analytics/executive-metrics endpoint. All ratios are
// honest-null when the denominator is 0 (never 0/∞). Money fields are minor-unit strings.
export interface ExecutiveMetricDto {
  currency_code: string;
  realized_minor: string;
  total_orders: string;
  distinct_customers: string;
  aov_minor: string | null;
  ltv_minor: string | null;
  repeat_rate_pct: string | null;
  cac_minor: string | null;
  roas_ratio: string | null;
}

export type AnalyticsExecutiveMetricsResponse =
  | { state: 'no_data'; generated_at?: string }
  | { state: 'has_data'; metrics: ExecutiveMetricDto[]; generated_at?: string };

// ── Insight + Opportunity Engine + AI Copilot briefing ──────────────────────
// Mirrors apps/core analytics get-insights-briefing.ts (InsightDto / BriefingDto). Money stays a
// minor-unit string; the UI formats per currency via formatMoneyDisplay.
export type InsightKind = 'risk' | 'opportunity' | 'trend';
export type InsightSeverity = 'high' | 'medium' | 'low' | 'info';
export type InsightConfidence = 'high' | 'medium' | 'low';

export interface InsightDto {
  id: string;
  detector: string;
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  why: string;
  recommended_action: string;
  currency_code: string | null;
  impact_minor: string | null;
  direction: 'up' | 'down' | 'flat' | null;
  delta_pct: string | null;
  confidence: InsightConfidence;
  evidence: Record<string, string | number | null>;
  /** Set once the insight is materialized as a recommendation (the audited decision loop). */
  recommendation_id?: string | null;
  status?: string | null;
}

export interface BriefingDto {
  headline: string;
  summary: string[];
  primary_currency: string | null;
  counts: { risks: number; opportunities: number; trends: number };
  total_impact_minor: string | null;
  window: { current: { from: string; to: string }; prior: { from: string; to: string } };
  source: 'deterministic';
  /** 'synthetic' when ANY contributing mart row is synthetic (demo seed) — drives the badge. */
  data_source: 'synthetic' | 'live';
  /** Gold-mart build time (max updated_at), ISO-8601 or null. Freshness guard. */
  as_of?: string | null;
  /** True when as_of exceeds the freshness SLO → UI warns the briefing may be stale. */
  stale?: boolean;
}

export type AnalyticsInsightsBriefingResponse =
  | { state: 'no_data' }
  | { state: 'has_data'; briefing: BriefingDto; insights: InsightDto[] };
