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

// ── Identity Domain Events (5 events — doc-07 15-field envelope) ───────────────
export {
  ConfidenceVerdictBandSchema,
  IdentityMintedPayloadSchema,
  IdentityMintedEventSchema,
  IdentityLinkedPayloadSchema,
  IdentityLinkedEventSchema,
  IdentityMergedPayloadSchema,
  IdentityMergedEventSchema,
  IdentitySuppressionReasonSchema,
  IdentitySuppressedPayloadSchema,
  IdentitySuppressedEventSchema,
  IdentityReviewQueuedPayloadSchema,
  IdentityReviewQueuedEventSchema,
  IDENTITY_MINTED_TOPIC_SUFFIX,
  IDENTITY_LINKED_TOPIC_SUFFIX,
  IDENTITY_MERGED_TOPIC_SUFFIX,
  IDENTITY_SUPPRESSED_TOPIC_SUFFIX,
  IDENTITY_REVIEW_QUEUED_TOPIC_SUFFIX,
  IDENTITY_MINTED_AVRO_SUBJECT,
  IDENTITY_LINKED_AVRO_SUBJECT,
  IDENTITY_MERGED_AVRO_SUBJECT,
  IDENTITY_SUPPRESSED_AVRO_SUBJECT,
  IDENTITY_REVIEW_QUEUED_AVRO_SUBJECT,
  IDENTITY_EVENT_SCHEMAS,
} from './events/identity.events.v1.js';
export type {
  ConfidenceVerdictBand,
  IdentityMintedPayload,
  IdentityMintedEvent,
  IdentityLinkedPayload,
  IdentityLinkedEvent,
  IdentityMergedPayload,
  IdentityMergedEvent,
  IdentitySuppressionReason,
  IdentitySuppressedPayload,
  IdentitySuppressedEvent,
  IdentityReviewQueuedPayload,
  IdentityReviewQueuedEvent,
} from './events/identity.events.v1.js';

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
  MarketplaceTileInstanceSchema,
  MarketplaceListResponseSchema,
  ConnectRequestSchema,
  ConnectResponseSchema,
  // Ad-account activation (0106)
  ActivateAdAccountResponseSchema,
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
  MarketplaceTileInstance,
  MarketplaceListResponse,
  ConnectRequest,
  ConnectResponse,
  // Ad-account activation (0106)
  ActivateAdAccountResponse,
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
  JourneyEventDtoSchema,
  JourneyEventsLedgerSchema,
  JourneyStitchRateSchema,
  OrderStatusMixRowDtoSchema,
  OrderStatusMixSchema,
  TopProductDtoSchema,
  TopProductsSchema,
  CostConfidenceSchema,
  CostScopeSchema,
  CostTypeSchema,
  ContributionMarginDtoSchema,
  ContributionMarginSchema,
  CostInputDtoSchema,
  CostInputsListSchema,
  OrderListItemDtoSchema,
  OrdersListSchema,
  ProductDetailDtoSchema,
  ProductDetailSchema,
  ProductAffinityPairDtoSchema,
  ProductAffinitySchema,
  ProductCategoryNodeDtoSchema,
  ProductCategoriesSchema,
  CourierOutcomeDtoSchema,
  PincodeOutcomeDtoSchema,
  ShipmentOutcomesSchema,
  ReturnClassSchema,
  ReturnClassBucketDtoSchema,
  ReturnCourierBucketDtoSchema,
  ReturnFunnelSchema,
  PageTypeBucketDtoSchema,
  BrowsedItemDtoSchema,
  BehaviorOverviewSchema,
  FunnelStageDtoSchema,
  FunnelAnalyticsSchema,
  FunnelStepSchema,
  FunnelUserDtoSchema,
  FunnelUsersSchema,
  AbandonedCartSchema,
  EngagementSchema,
  SearchDayBucketDtoSchema,
  SearchBehaviorSchema,
  FormBucketDtoSchema,
  FormDayBucketDtoSchema,
  FormConversionSchema,
  JourneyPathRowDtoSchema,
  JourneyPathLinkDtoSchema,
  JourneyPathsSchema,
  RepeatLatencyBucketDtoSchema,
  RepeatLatencySchema,
  CohortUserDtoSchema,
  CohortUsersSchema,
  DeliveryTimeBucketDtoSchema,
  DeliveryTimeCourierDtoSchema,
  DeliveryTimeSchema,
  UtmSourceRowDtoSchema,
  UtmSourceSchema,
  CampaignAttributionRowDtoSchema,
  CampaignAttributionSchema,
  CampaignTimeseriesBucketDtoSchema,
  CampaignTimeseriesSchema,
  AttributedRevenueTimeseriesBucketDtoSchema,
  AttributedRevenueTimeseriesSchema,
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
  JourneyEventDto,
  JourneyEventsLedger,
  JourneyStitchRate,
  OrderStatusMixRowDto,
  OrderStatusMix,
  TopProductDto,
  TopProducts,
  CostConfidence,
  ContributionMarginDto,
  ContributionMargin,
  CostInputDto,
  CostInputsList,
  OrderListItemDto,
  OrdersList,
  ProductDetailDto,
  ProductDetail,
  ProductAffinityPairDto,
  ProductAffinity,
  ProductCategoryNodeDto,
  ProductCategories,
  CourierOutcomeDto,
  PincodeOutcomeDto,
  ShipmentOutcomes,
  ReturnClass,
  ReturnClassBucketDto,
  ReturnCourierBucketDto,
  ReturnFunnel,
  PageTypeBucketDto,
  BrowsedItemDto,
  BehaviorOverview,
  FunnelStageDto,
  FunnelAnalytics,
  FunnelStep,
  FunnelUserDto,
  FunnelUsers,
  AbandonedCart,
  Engagement,
  SearchDayBucketDto,
  SearchBehavior,
  FormBucketDto,
  FormDayBucketDto,
  FormConversion,
  JourneyPathRowDto,
  JourneyPathLinkDto,
  JourneyPaths,
  RepeatLatencyBucketDto,
  RepeatLatency,
  CohortUserDto,
  CohortUsers,
  DeliveryTimeBucketDto,
  DeliveryTimeCourierDto,
  DeliveryTime,
  UtmSourceRowDto,
  UtmSource,
  CampaignAttributionRowDto,
  CampaignAttribution,
  CampaignTimeseriesBucketDto,
  CampaignTimeseries,
  AttributedRevenueTimeseriesBucketDto,
  AttributedRevenueTimeseries,
} from './api/analytics.api.v1.js';

// ── Saved segments (P2) — CRUD + preview over ops.saved_segment (operational state) ──
export {
  SegmentDefinitionSchema,
  SavedSegmentDtoSchema,
  SavedSegmentListSchema,
  CreateSegmentRequestSchema,
  UpdateSegmentRequestSchema,
  SegmentPreviewRequestSchema,
  SegmentPreviewResultSchema,
} from './api/segment.api.v1.js';
export type {
  SegmentDefinition,
  SavedSegmentDto,
  SavedSegmentList,
  CreateSegmentRequest,
  UpdateSegmentRequest,
  SegmentPreviewRequest,
  SegmentPreviewResult,
} from './api/segment.api.v1.js';

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
  AskScalarSchema,
  ComputedNumberSchema,
  AskBrainBindingSchema,
  AskBrainResultSchema,
} from './api/ask.api.v1.js';
export type {
  ConfidenceGrade,
  TrustTier,
  MetricVersion,
  ResolvedParams,
  AskScalar,
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
  CustomerListItemSchema,
  CustomerListSchema,
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
  CustomerListItem,
  CustomerList,
  VaultCoverage,
  ErasureResult,
  MergeReview,
  MergeReviewList,
  MergeResolveResult,
  UnmergeResult,
} from './api/identity.api.v1.js';

// ── Identity DOMAIN contracts (v3 cluster — resolver/matcher/graph-repo vocabulary) ──
// Distinct from the api/identity.api.v1 READ DTOs above: the hash-only Identifier value
// object, the integer ConfidenceVerdict, the reversible IdentityDecision command union, the
// Matcher port + registry (deferred strategies registered-DISABLED), and the Neo4j
// IdentityGraphRepository port. See packages/contracts/src/identity/index.ts.
export {
  IDENTITY_RULE_VERSION,
  IdentifierTypeSchema,
  IdentifierTierSchema,
  IdentifierHashSchema,
  IdentifierSchema,
  ConfidenceBandSchema,
  IdentifierComboMemberSchema,
  ConfidenceVerdictSchema,
  CompensationKindSchema,
  CompensationSchema,
  MintDecisionSchema,
  LinkDecisionSchema,
  MergeDecisionSchema,
  UnmergeDecisionSchema,
  SuppressDecisionSchema,
  RouteToReviewDecisionSchema,
  IdentityDecisionSchema,
  IdentityCommandSchema,
  MatcherStatusSchema,
  MatcherStrategySchema,
  MatcherDescriptorSchema,
  NotImplementedYet,
  DisabledMatcher,
  IDENTITY_MATCHER_REGISTRY,
  REF_PREFIX,
  brainRef,
} from './identity/index.js';
export type {
  IdentifierType,
  IdentifierTier,
  IdentifierHash,
  Identifier,
  ConfidenceBand,
  IdentifierComboMember,
  ConfidenceVerdict,
  CompensationKind,
  Compensation,
  MintDecision,
  LinkDecision,
  MergeDecision,
  UnmergeDecision,
  SuppressDecision,
  RouteToReviewDecision,
  IdentityDecision,
  IdentityCommand,
  MatcherStatus,
  MatcherStrategy,
  MatcherInput,
  Matcher,
  MatcherDescriptor,
  IdentityGraphReadState,
  IdentityDecisionReceipt,
  IdentityGraphRepository,
} from './identity/index.js';

export {
  BillingPeriodSchema,
  BillingPeriodsSchema,
  SealPeriodResultSchema,
  BillLineSchema,
  InspectableBillSchema,
  InvoiceLineSchema,
  CreditNoteSchema,
  InvoiceSchema,
  IssueInvoiceResultSchema,
  IssueCreditNoteResultSchema,
} from './api/billing.api.v1.js';
export type {
  BillingPeriod,
  BillingPeriods,
  SealPeriodResult,
  BillLine,
  InspectableBill,
  InvoiceLine,
  CreditNote,
  Invoice,
  IssueInvoiceResult,
  IssueCreditNoteResult,
} from './api/billing.api.v1.js';
export {
  ConfidenceSchema,
  RecommendationEvidenceSchema,
  RecommendationOutcomeSchema,
  RecommendationSchema,
  RecommendationsSchema,
  GenerateRecommendationsResultSchema,
  RecommendationActionKindSchema,
  RecordRecommendationActionRequestSchema,
  RecommendationActionSchema,
} from './api/recommendation.api.v1.js';
export type {
  Confidence,
  RecommendationEvidence,
  RecommendationOutcome,
  Recommendation,
  Recommendations,
  GenerateRecommendationsResult,
  RecommendationActionKind,
  RecordRecommendationActionRequest,
  RecommendationAction,
} from './api/recommendation.api.v1.js';
export {
  ModelStageSchema,
  ModelSchema,
  ModelListSchema,
  PromoteModelRequestSchema,
  ServingModelSchema,
  ServedScoreSchema,
  CustomerScoreResultSchema,
} from './api/ml.api.v1.js';
export type {
  ModelStage,
  Model,
  ModelList,
  PromoteModelRequest,
  ServingModel,
  ServedScore,
  CustomerScoreResult,
} from './api/ml.api.v1.js';
export { AttributionReconcileResultSchema } from './api/attribution.api.v1.js';
export type { AttributionReconcileResult } from './api/attribution.api.v1.js';
export {
  FoundationTierSchema,
  FoundationStepSchema,
  FoundationNextActionSchema,
  FoundationHealthSchema,
} from './api/foundation.api.v1.js';
export type {
  FoundationTier,
  FoundationStep,
  FoundationNextAction,
  FoundationHealth,
} from './api/foundation.api.v1.js';
export { EntitlementEntrySchema, EntitlementsSchema } from './api/entitlements.api.v1.js';
export type { EntitlementEntry, Entitlements } from './api/entitlements.api.v1.js';

// ── V4 Intelligence layer — attribution-model port + registry + Gold data product ──
export {
  MedallionLayerSchema,
  ConfidenceScoreSchema,
  WEIGHT_SCALE,
  AttributionModelClassSchema,
  EnabledAttributionModelSchema,
  DisabledPredictiveModelSchema,
  ATTRIBUTION_MODEL_REGISTRY,
  DISABLED_PREDICTIVE_MODELS,
  NotImplementedYetError,
  isAttributionModelEnabled,
  assertAttributionModelEnabled,
  GoldDataProductSchema,
  GoldDataProductsSchema,
  GOLD_DATA_PRODUCT_REGISTRY,
  findGoldDataProduct,
  HealthBandSchema,
  ChurnScoreSchema,
  LifecycleStageSchema,
  Customer360ContractSchema,
} from './api/intelligence.api.v1.js';
export type {
  MedallionLayer,
  ConfidenceScore,
  AttributionTouchInput,
  AttributionModelPort,
  AttributionModelClass,
  EnabledAttributionModel,
  DisabledPredictiveModel,
  GoldDataProduct,
  GoldDataProducts,
  HealthBand,
  ChurnScore,
  LifecycleStage,
  Customer360Contract,
} from './api/intelligence.api.v1.js';

// ── V4 MCP read-only lookup-tool schemas (input/output; brand_id never an input) ──
export {
  BigIntCountSchema,
  IsoDateSchema,
  BrainIdLookupInputSchema,
  PrincipalScopedInputSchema,
  HashPrefix12Schema,
  Customer360TopCustomerSchema,
  Customer360LookupOutputSchema,
  JourneyTopRowSchema,
  JourneyLookupOutputSchema,
  TimelineEntrySchema,
  TimelineLookupOutputSchema,
  IdentityComboMemberSchema,
  IdentityMergeExplanationSchema,
  IdentityExplainabilityLookupOutputSchema,
  AttributionLookupInputSchema,
  McpChannelRoasSchema,
  AttributionLookupOutputSchema,
  LtvLookupOutputSchema,
  MarketingPerfLookupInputSchema,
  McpCampaignRoasSchema,
  MarketingPerfLookupOutputSchema,
  RecFeatureRowSchema,
  RecFeatureLookupOutputSchema,
  SegmentLookupInputSchema,
  MCP_LOOKUP_SCHEMAS,
} from './api/mcp.api.v1.js';
export type {
  BigIntCount,
  IsoDate,
  BrainIdLookupInput,
  PrincipalScopedInput,
  HashPrefix12,
  Customer360TopCustomer,
  Customer360LookupOutput,
  JourneyTopRow,
  JourneyLookupOutput,
  TimelineEntry,
  TimelineLookupOutput,
  IdentityComboMember,
  IdentityMergeExplanation,
  IdentityExplainabilityLookupOutput,
  AttributionLookupInput,
  McpChannelRoas,
  AttributionLookupOutput,
  LtvLookupOutput,
  MarketingPerfLookupInput,
  McpCampaignRoas,
  MarketingPerfLookupOutput,
  RecFeatureRow,
  RecFeatureLookupOutput,
  SegmentLookupInput,
} from './api/mcp.api.v1.js';

// ── V4 Cache-invalidation events (gold.rewritten.v1 / cache.invalidate.v1) ────────
export {
  CacheScopeSchema,
  GoldRewrittenPayloadSchema,
  GoldRewrittenEventSchema,
  GOLD_REWRITTEN_V1_TOPIC_SUFFIX,
  GOLD_REWRITTEN_V1_EVENT_NAME,
  GOLD_REWRITTEN_V1_AVRO_SUBJECT,
  CacheInvalidateReasonSchema,
  CacheInvalidatePayloadSchema,
  CacheInvalidateEventSchema,
  CACHE_INVALIDATE_V1_TOPIC_SUFFIX,
  CACHE_INVALIDATE_V1_EVENT_NAME,
  CACHE_INVALIDATE_V1_AVRO_SUBJECT,
  CACHE_EVENT_SCHEMAS,
} from './events/cache.invalidate.v1.js';
export type {
  CacheScope,
  GoldRewrittenEvent,
  CacheInvalidateReason,
  CacheInvalidateEvent,
} from './events/cache.invalidate.v1.js';

// ── V4 Customer360 recompute receipt (intelligence.customer360.recomputed.v1) ─────
export {
  Customer360RecomputeReasonSchema,
  Customer360RecomputedPayloadSchema,
  Customer360RecomputedEventSchema,
  CUSTOMER360_RECOMPUTED_V1_TOPIC_SUFFIX,
  CUSTOMER360_RECOMPUTED_V1_EVENT_NAME,
  CUSTOMER360_RECOMPUTED_V1_AVRO_SUBJECT,
  CUSTOMER360_EVENT_SCHEMAS,
} from './events/intelligence.customer360.recomputed.v1.js';
export type {
  Customer360RecomputeReason,
  Customer360RecomputedEvent,
} from './events/intelligence.customer360.recomputed.v1.js';
