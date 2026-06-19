/**
 * @brain/contracts — Zod-as-source-of-truth for all shared contracts.
 *
 * This package is the single source of truth for:
 *  - Event schemas (Avro wire format generated from these)
 *  - API request/response schemas (OpenAPI generated from these)
 *  - MCP tool input/output schemas
 *  - Data quality category declarations
 *
 * CODEOWNERS: /packages/contracts/ requires consuming-domain owner approval (I-E01).
 * No contract may be changed without a prior codegen run that commits the generated artifacts.
 */

// ── Collector Events (Sprint-0 legacy) ────────────────────────────────────────
export {
  CollectorEventV1Schema,
  COLLECTOR_EVENT_V1_TOPIC_SUFFIX,
  COLLECTOR_EVENT_V1_AVRO_SUBJECT,
} from './events/sample.collector.event.v1.js';
export type { CollectorEventV1 } from './events/sample.collector.event.v1.js';

// ── M1 Domain Events (9 events — doc-07 envelope) ─────────────────────────────
export {
  EventEnvelopeBaseSchema,
  UserRegisteredEventSchema,
  UserLoggedInEventSchema,
  WorkspaceCreatedEventSchema,
  BrandCreatedEventSchema,
  UserInvitedEventSchema,
  ConnectorConnectedEventSchema,
  ConnectorSyncStartedEventSchema,
  PixelInstalledEventSchema,
  PixelVerifiedEventSchema,
  USER_REGISTERED_TOPIC_SUFFIX,
  USER_LOGGED_IN_TOPIC_SUFFIX,
  WORKSPACE_CREATED_TOPIC_SUFFIX,
  BRAND_CREATED_TOPIC_SUFFIX,
  USER_INVITED_TOPIC_SUFFIX,
  CONNECTOR_CONNECTED_TOPIC_SUFFIX,
  CONNECTOR_SYNC_STARTED_TOPIC_SUFFIX,
  PIXEL_INSTALLED_TOPIC_SUFFIX,
  PIXEL_VERIFIED_TOPIC_SUFFIX,
  M1_EVENT_SCHEMAS,
  buildTopic,
} from './events/m1.events.v1.js';
export type {
  EventEnvelopeBase,
  UserRegisteredEvent,
  UserLoggedInEvent,
  WorkspaceCreatedEvent,
  BrandCreatedEvent,
  UserInvitedEvent,
  ConnectorConnectedEvent,
  ConnectorSyncStartedEvent,
  PixelInstalledEvent,
  PixelVerifiedEvent,
} from './events/m1.events.v1.js';

// ── API contracts (Sprint-0 legacy) ──────────────────────────────────────────
export {
  IngestEventHeadersSchema,
  IngestEventBodySchema,
  IngestEventRequestSchema,
  IngestEventAcceptedResponseSchema,
  ApiErrorResponseSchema,
  GetBrandEventCountInputSchema,
  GetBrandEventCountOutputSchema,
} from './api/sample.api.v1.js';
export type {
  IngestEventHeaders,
  IngestEventBody,
  IngestEventRequest,
  IngestEventAcceptedResponse,
  ApiErrorResponse,
  GetBrandEventCountInput,
  GetBrandEventCountOutput,
} from './api/sample.api.v1.js';

// ── M1 Auth API ───────────────────────────────────────────────────────────────
export {
  MutationHeadersSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  VerifyEmailRequestSchema,
  OkResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutRequestSchema,
  ForgotPasswordRequestSchema,
  ForgotPasswordResponseSchema,
  ResetPasswordRequestSchema,
  CurrentUserResponseSchema,
} from './api/auth.api.v1.js';
export type {
  MutationHeaders,
  RegisterRequest,
  RegisterResponse,
  VerifyEmailRequest,
  OkResponse,
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  ResetPasswordRequest,
  CurrentUserResponse,
} from './api/auth.api.v1.js';

// ── M1 Workspace API ──────────────────────────────────────────────────────────
export {
  RoleCodeSchema,
  WorkspaceSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  GetWorkspaceResponseSchema,
  UpdateWorkspaceRequestSchema,
  UpdateWorkspaceResponseSchema,
  ListWorkspacesQuerySchema,
  ListWorkspacesResponseSchema,
  ProvisionOnboardingRequestSchema,
  ProvisionOnboardingResponseSchema,
} from './api/workspace.api.v1.js';
export type {
  RoleCode,
  Workspace,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  GetWorkspaceResponse,
  UpdateWorkspaceRequest,
  UpdateWorkspaceResponse,
  ListWorkspacesQuery,
  ListWorkspacesResponse,
  ProvisionOnboardingRequest,
  ProvisionOnboardingResponse,
} from './api/workspace.api.v1.js';

// ── M1 Brand API ──────────────────────────────────────────────────────────────
export {
  BrandSchema,
  CreateBrandRequestSchema,
  CreateBrandResponseSchema,
  GetBrandResponseSchema,
  UpdateBrandRequestSchema,
  UpdateBrandResponseSchema,
  ListBrandsQuerySchema,
  ListBrandsResponseSchema,
  SwitchBrandResponseSchema,
} from './api/brand.api.v1.js';
export type {
  Brand,
  CreateBrandRequest,
  CreateBrandResponse,
  GetBrandResponse,
  UpdateBrandRequest,
  UpdateBrandResponse,
  ListBrandsQuery,
  ListBrandsResponse,
  SwitchBrandResponse,
} from './api/brand.api.v1.js';

// ── M1 Member / Invite API ────────────────────────────────────────────────────
export {
  MemberSchema,
  InviteSchema,
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  AcceptInviteRequestSchema,
  AcceptInviteResponseSchema,
  ListMembersQuerySchema,
  ListMembersResponseSchema,
  UpdateMemberRoleRequestSchema,
  UpdateMemberRoleResponseSchema,
  ListPendingInvitesQuerySchema,
  ListPendingInvitesResponseSchema,
  ResendInviteResponseSchema,
  SuspendMemberResponseSchema,
  ReactivateMemberResponseSchema,
} from './api/member.api.v1.js';
export type {
  Member,
  Invite,
  CreateInviteRequest,
  CreateInviteResponse,
  AcceptInviteRequest,
  AcceptInviteResponse,
  ListMembersQuery,
  ListMembersResponse,
  UpdateMemberRoleRequest,
  UpdateMemberRoleResponse,
  ListPendingInvitesQuery,
  ListPendingInvitesResponse,
  ResendInviteResponse,
  SuspendMemberResponse,
  ReactivateMemberResponse,
} from './api/member.api.v1.js';

// ── M1 Connector API ──────────────────────────────────────────────────────────
export {
  ConnectorInstanceSchema,
  ConnectorListEntrySchema,
  ListConnectorsResponseSchema,
  ShopifyInstallQuerySchema,
  ShopifyInstallResponseSchema,
  ShopifyCallbackQuerySchema,
  ConnectorStatusResponseSchema,
  // Marketplace (feat-connector-marketplace A0 freeze)
  ConnectableConnectorType,
  ConnectorTypeSchema,
  HealthStateSchema,
  SafetyRatingSchema,
  MarketplaceTileSchema,
  MarketplaceListResponseSchema,
  ConnectRequestSchema,
  ConnectResponseSchema,
  // On-demand "Sync now" trigger (feat-connector-sync-now)
  SyncTriggerDataSchema,
  SyncTriggerResponseSchema,
} from './api/connector.api.v1.js';
export type {
  ConnectorInstance,
  ConnectorListEntry,
  ListConnectorsResponse,
  ShopifyInstallQuery,
  ShopifyInstallResponse,
  ShopifyCallbackQuery,
  ConnectorStatusResponse,
  // Marketplace types (feat-connector-marketplace A0 freeze)
  HealthState,
  SafetyRating,
  MarketplaceTile,
  MarketplaceListResponse,
  ConnectRequest,
  ConnectResponse,
  // On-demand "Sync now" trigger (feat-connector-sync-now)
  SyncTriggerData,
  SyncTriggerResponse,
} from './api/connector.api.v1.js';

// ── M1 Pixel API ──────────────────────────────────────────────────────────────
export {
  PixelInstallationSchema,
  GetPixelInstallationResponseSchema,
  VerifyPixelRequestSchema,
  VerifyPixelResponseSchema,
  PixelHealthResponseSchema,
} from './api/pixel.api.v1.js';
export type {
  PixelInstallation,
  GetPixelInstallationResponse,
  VerifyPixelRequest,
  VerifyPixelResponse,
  PixelHealthResponse,
} from './api/pixel.api.v1.js';

// ── Backfill contracts (feat-connector-backfill A0 freeze) ───────────────────
export {
  OrderBackfillPropertiesSchema,
  ORDER_BACKFILL_V1_TOPIC_SUFFIX,
  ORDER_BACKFILL_V1_EVENT_NAME,
  ORDER_BACKFILL_V1_AVRO_SUBJECT,
} from './events/order.backfill.v1.js';
export type { OrderBackfillProperties } from './events/order.backfill.v1.js';

export {
  isBackfillTerminal,
  isBackfillInProgress,
} from './api/connector.backfill.api.v1.js';
export type {
  BackfillTriggerResponse,
  BackfillJobProgress,
  BackfillErrorCode,
  BackfillErrorResponse,
} from './api/connector.backfill.api.v1.js';

// ── BFF Read DTOs (analytics/dataquality/ask) — shared web↔core read contracts ──
// Single source of truth for the drift-prone money/bigint READ surfaces. Core's use-case
// return types and web's consumer types BOTH derive from these (z.infer). See
// packages/contracts/src/api/analytics.api.v1.ts header for the full invariant list.
export {
  MinorUnitsSchema,
  MoneyRecordSchema,
  AttributionModelIdSchema,
  JourneyChannelSchema,
  LifecycleStateSchema,
  DqLetterGradeSchema,
  EngineTrustTierSchema,
  DataSourceSchema,
} from './api/_money.js';
export type {
  MinorUnits,
  MoneyRecord,
  AttributionModelId,
  JourneyChannel,
  LifecycleState,
  DqLetterGrade,
  EngineTrustTier,
  DataSource,
} from './api/_money.js';

export {
  RevenueSnapshotSchema,
  KpiSummaryDtoSchema,
  KpiSummarySchema,
  ChannelContributionDtoSchema,
  AttributionByChannelSchema,
  AttributionReconciliationSchema,
  ChannelRoasDtoSchema,
  ChannelRoasSchema,
  FirstTouchMixRowDtoSchema,
  JourneyFirstTouchMixSchema,
  TimelineTouchDtoSchema,
  JourneyTimelineSchema,
  JourneyStitchRateSchema,
  OrderStatusMixRowDtoSchema,
  OrderStatusMixSchema,
} from './api/analytics.api.v1.js';
export type {
  RevenueSnapshot,
  KpiSummaryDto,
  KpiSummary,
  ChannelContributionDto,
  AttributionByChannel,
  AttributionReconciliation,
  ChannelRoasDto,
  ChannelRoas,
  FirstTouchMixRowDto,
  JourneyFirstTouchMix,
  TimelineTouchDto,
  JourneyTimeline,
  JourneyStitchRate,
  OrderStatusMixRowDto,
  OrderStatusMix,
} from './api/analytics.api.v1.js';

export {
  DqCategorySchema,
  FreshnessSlaStatusSchema,
  DqGradeRowSchema,
  DqCoverageSchema,
  GateDecisionSchema,
  DataQualitySummarySchema,
} from './api/dataquality.api.v1.js';
export type {
  DqCategory,
  FreshnessSlaStatus,
  DqGradeRow,
  DqCoverage,
  GateDecision,
  DataQualitySummary,
} from './api/dataquality.api.v1.js';

export {
  ConfidenceGradeSchema,
  TrustTierSchema,
  MetricVersionSchema,
  ResolvedParamsSchema,
  ComputedNumberSchema,
  AskBrainBindingSchema,
  AskBrainResultSchema,
} from './api/ask.api.v1.js';
export type {
  ConfidenceGrade,
  TrustTier,
  MetricVersion,
  ResolvedParams,
  ComputedNumber,
  AskBrainBinding,
  AskBrainResult,
} from './api/ask.api.v1.js';

// ── Consent suppression read seam (D13 — feat-d13-consent-cancontact) ─────────
export { CONSENT_CATEGORIES } from './consent/suppression.js';
export type {
  ConsentCategory,
  SuppressionReason,
  SuppressionResult,
  SuppressionQuery,
} from './consent/suppression.js';

// ── Data quality declarations ─────────────────────────────────────────────────
export {
  DqFreshnessCheckSchema,
  DqCompletenessCheckSchema,
  DqSchemaValidityCheckSchema,
  DqReconciliationCheckSchema,
  DqCheckSchema,
} from './dq/index.js';
export type {
  DqFreshnessCheck,
  DqCompletenessCheck,
  DqSchemaValidityCheck,
  DqReconciliationCheck,
  DqCheck,
} from './dq/index.js';

// ── Identity control-plane read seam (P0-C — Customer 360) ────────────────────
export {
  Customer360ProfileSchema,
  Customer360IdentifierSchema,
  Customer360MergeSchema,
  Customer360Schema,
  VaultCoverageSchema,
  ErasureResultSchema,
  MergeReviewSchema,
  MergeReviewListSchema,
  MergeResolveResultSchema,
  UnmergeResultSchema,
} from './api/identity.api.v1.js';
export type {
  Customer360Profile,
  Customer360Identifier,
  Customer360Merge,
  Customer360,
  VaultCoverage,
  ErasureResult,
  MergeReview,
  MergeReviewList,
  MergeResolveResult,
  UnmergeResult,
} from './api/identity.api.v1.js';
export {
  BillingPeriodSchema,
  BillingPeriodsSchema,
  SealPeriodResultSchema,
  BillLineSchema,
  InspectableBillSchema,
} from './api/billing.api.v1.js';
export type {
  BillingPeriod,
  BillingPeriods,
  SealPeriodResult,
  BillLine,
  InspectableBill,
} from './api/billing.api.v1.js';
