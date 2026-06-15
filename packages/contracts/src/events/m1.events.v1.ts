/**
 * m1.events.v1 — Zod schemas for all 9 M1 domain events (doc-07 envelope).
 *
 * Envelope shape: schema_version, event_id, brand_id, correlation_id,
 *   event_name, occurred_at, payload.
 *
 * Topics: {env}.{domain}.{event}.v1
 * Partition key: brand_id:event_id
 * Idempotency key: (brand_id, event_id)
 *
 * INVARIANTS:
 *  - brand_id REQUIRED on every event (I-S01). For user/workspace events
 *    with no brand yet, brand_id carries the organization_id as the tenant key.
 *  - No raw PII in any payload (I-S02).
 *  - schema_version = additive evolution only (I-E02 FULL_TRANSITIVE).
 */
import { z } from 'zod';

// ── Base event envelope (doc-07) ──────────────────────────────────────────────

export const EventEnvelopeBaseSchema = z.object({
  schema_version: z.literal('1').default('1'),
  event_id: z.string().uuid(),
  /**
   * Tenant key — required on every event.
   * For pre-brand events (user.registered, workspace.created), this carries organization_id.
   */
  brand_id: z.string().uuid(),
  correlation_id: z.string().min(1).max(128),
  event_name: z.string().min(1).max(128),
  occurred_at: z.string().datetime({ offset: false }),
});

export type EventEnvelopeBase = z.infer<typeof EventEnvelopeBaseSchema>;

// ── 1. user.registered ───────────────────────────────────────────────────────
// Emitted: after app_user insert + verification token issued.
// brand_id carries organization_id (user may not have a brand yet).

export const UserRegisteredPayloadSchema = z.object({
  user_id: z.string().uuid(),
  /** Masked email for traceability (no raw PII). e.g. u***@domain.com */
  email_masked: z.string(),
  verification_required: z.boolean().default(true),
});

export const UserRegisteredEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('user.registered'),
  payload: UserRegisteredPayloadSchema,
});
export type UserRegisteredEvent = z.infer<typeof UserRegisteredEventSchema>;

export const USER_REGISTERED_TOPIC_SUFFIX = 'user.registered.v1' as const;

// ── 2. user.logged_in ────────────────────────────────────────────────────────
// Emitted: after user_session insert.

export const UserLoggedInPayloadSchema = z.object({
  user_id: z.string().uuid(),
  session_jti: z.string().uuid(),
  /** IP address (anonymised to /24 prefix for PII compliance). */
  ip_prefix: z.string().max(20).optional(),
});

export const UserLoggedInEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('user.logged_in'),
  payload: UserLoggedInPayloadSchema,
});
export type UserLoggedInEvent = z.infer<typeof UserLoggedInEventSchema>;

export const USER_LOGGED_IN_TOPIC_SUFFIX = 'user.logged_in.v1' as const;

// ── 3. workspace.created ─────────────────────────────────────────────────────
// Emitted: after organization insert.
// brand_id carries organization_id.

export const WorkspaceCreatedPayloadSchema = z.object({
  organization_id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  owner_user_id: z.string().uuid(),
  region_code: z.string(),
});

export const WorkspaceCreatedEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('workspace.created'),
  payload: WorkspaceCreatedPayloadSchema,
});
export type WorkspaceCreatedEvent = z.infer<typeof WorkspaceCreatedEventSchema>;

export const WORKSPACE_CREATED_TOPIC_SUFFIX = 'workspace.created.v1' as const;

// ── 4. brand.created ─────────────────────────────────────────────────────────
// Emitted: after brand insert.

export const BrandCreatedPayloadSchema = z.object({
  brand_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  display_name: z.string(),
  region_code: z.string(),
});

export const BrandCreatedEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('brand.created'),
  payload: BrandCreatedPayloadSchema,
});
export type BrandCreatedEvent = z.infer<typeof BrandCreatedEventSchema>;

export const BRAND_CREATED_TOPIC_SUFFIX = 'brand.created.v1' as const;

// ── 5. user.invited ──────────────────────────────────────────────────────────
// Emitted: after invite insert (before email send).

export const UserInvitedPayloadSchema = z.object({
  invite_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  brand_id: z.string().uuid().nullable(),
  /** Masked email (no raw PII — I-S02). */
  email_masked: z.string(),
  role_code: z.enum(['owner', 'brand_admin', 'manager', 'analyst']),
  invited_by_user_id: z.string().uuid(),
  expires_at: z.string().datetime({ offset: false }),
});

export const UserInvitedEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('user.invited'),
  payload: UserInvitedPayloadSchema,
});
export type UserInvitedEvent = z.infer<typeof UserInvitedEventSchema>;

export const USER_INVITED_TOPIC_SUFFIX = 'user.invited.v1' as const;

// ── 6. connector.connected ───────────────────────────────────────────────────
// Emitted: after connector_instance insert (post-HMAC, secret_ref stored — NN-2).

export const ConnectorConnectedPayloadSchema = z.object({
  connector_instance_id: z.string().uuid(),
  provider: z.enum(['shopify']),
  shop_domain: z.string(),
  /** ARN reference only — never the token itself (NN-2 / I-S09). */
  secret_ref: z.string(),
});

export const ConnectorConnectedEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('connector.connected'),
  payload: ConnectorConnectedPayloadSchema,
});
export type ConnectorConnectedEvent = z.infer<typeof ConnectorConnectedEventSchema>;

export const CONNECTOR_CONNECTED_TOPIC_SUFFIX = 'connector.connected.v1' as const;

// ── 7. connector.sync_started ────────────────────────────────────────────────
// Emitted: when connector_sync_status transitions to 'syncing'.

export const ConnectorSyncStartedPayloadSchema = z.object({
  connector_instance_id: z.string().uuid(),
  provider: z.enum(['shopify']),
  resource: z.string(),
});

export const ConnectorSyncStartedEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('connector.sync_started'),
  payload: ConnectorSyncStartedPayloadSchema,
});
export type ConnectorSyncStartedEvent = z.infer<typeof ConnectorSyncStartedEventSchema>;

export const CONNECTOR_SYNC_STARTED_TOPIC_SUFFIX = 'connector.sync_started.v1' as const;

// ── 8. pixel.installed ───────────────────────────────────────────────────────
// Emitted: after pixel_installation insert.

export const PixelInstalledPayloadSchema = z.object({
  pixel_installation_id: z.string().uuid(),
  install_token: z.string().uuid(),
  target_host: z.string(),
});

export const PixelInstalledEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('pixel.installed'),
  payload: PixelInstalledPayloadSchema,
});
export type PixelInstalledEvent = z.infer<typeof PixelInstalledEventSchema>;

export const PIXEL_INSTALLED_TOPIC_SUFFIX = 'pixel.installed.v1' as const;

// ── 9. pixel.verified ────────────────────────────────────────────────────────
// Emitted: after verify success → pixel_status write.

export const PixelVerifiedPayloadSchema = z.object({
  pixel_installation_id: z.string().uuid(),
  target_host: z.string(),
  verified_at: z.string().datetime({ offset: false }),
});

export const PixelVerifiedEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('pixel.verified'),
  payload: PixelVerifiedPayloadSchema,
});
export type PixelVerifiedEvent = z.infer<typeof PixelVerifiedEventSchema>;

export const PIXEL_VERIFIED_TOPIC_SUFFIX = 'pixel.verified.v1' as const;

// ── Topic builder ─────────────────────────────────────────────────────────────

export function buildTopic(env: string, suffix: string): string {
  return `${env}.${suffix}`;
}

// ── All M1 event schemas (for codegen) ───────────────────────────────────────

export const M1_EVENT_SCHEMAS = {
  'user.registered': UserRegisteredEventSchema,
  'user.logged_in': UserLoggedInEventSchema,
  'workspace.created': WorkspaceCreatedEventSchema,
  'brand.created': BrandCreatedEventSchema,
  'user.invited': UserInvitedEventSchema,
  'connector.connected': ConnectorConnectedEventSchema,
  'connector.sync_started': ConnectorSyncStartedEventSchema,
  'pixel.installed': PixelInstalledEventSchema,
  'pixel.verified': PixelVerifiedEventSchema,
} as const;
