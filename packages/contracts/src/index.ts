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
