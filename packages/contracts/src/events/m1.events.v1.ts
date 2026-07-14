/**
 * m1.events.v1 — Zod schemas for all 9 M1 domain events (doc-07 envelope).
 *
 * Envelope shape (doc-07 15-field parity — all additions additive-OPTIONAL):
 *   1. schema_version   2. event_id        3. brand_id        4. correlation_id
 *   5. event_name       6. occurred_at     7. producer        8. schema_id
 *   9. partition_key   10. causation_id   11. ingested_at    12. source
 *  13. sequence        14. consent_flags  15. schema_name (canonical alias of event_name)
 *   (+ payload — supplied per-event by each .extend()).
 *
 * Topics: {env}.{domain}.{event}.v1
 * Partition key: brand_id:event_id  (carried explicitly in the `partition_key` field)
 * Idempotency key: (brand_id, event_id)
 *
 * INVARIANTS:
 *  - brand_id REQUIRED on every event (I-S01). For user/workspace events
 *    with no brand yet, brand_id carries the organization_id as the tenant key.
 *  - No raw PII in any payload (I-S02) — hashes only.
 *  - schema_version = additive evolution only (I-E02 FULL_TRANSITIVE). Every field
 *    added below fields 7-15 is `.optional()` (and `.nullable()` where noted) so the
 *    9 existing M1 events — and every already-emitted wire record — stay valid.
 *  - `trace_id` is DELIBERATELY ABSENT here: distributed-trace context is an
 *    observability concern and rides `correlation_id` + Kafka headers, not the envelope.
 */
import { z } from 'zod';

// ── Base event envelope (doc-07) ──────────────────────────────────────────────

export const EventEnvelopeBaseSchema = z.object({
  // ── Original doc-07 core (fields 1-6 — UNCHANGED, do not reorder/retype) ──
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

  // ── doc-07 15-field widening (fields 7-15 — additive-OPTIONAL, FULL_TRANSITIVE) ──

  /**
   * Logical producer that emitted this event — the service/job name
   * (e.g. 'core', 'stream-worker', 'identity-resolver'). Provenance for replay/audit.
   */
  producer: z.string().min(1).max(128).optional(),

  /**
   * Schema-registry identifier for the wire schema this record was serialized against
   * (Apicurio global/content id or subject@version). Lets a consumer resolve the exact
   * Avro schema without guessing from event_name.
   */
  schema_id: z.string().min(1).max(256).optional(),

  /**
   * The Kafka/Redpanda partition key actually used when producing this record.
   * Tenant-first by construction — for every brand-scoped lane this is `brand_id`
   * (identity.* MUST set partition_key = brand_id). Carried explicitly so Bronze can
   * audit partition discipline without re-deriving it.
   */
  partition_key: z.string().min(1).max(256).optional(),

  /**
   * The event_id of the event that DIRECTLY CAUSED this one (causation chain).
   * null at the root of a chain (no upstream cause). Distinct from correlation_id,
   * which groups a whole request flow.
   */
  causation_id: z.string().uuid().nullable().optional(),

  /**
   * ISO-8601 timestamp (UTC) when the event was first received/persisted at the
   * ingest boundary. NOT occurred_at (source time). Set by the collector/producer;
   * immutable once written to Bronze.
   */
  ingested_at: z.string().datetime({ offset: false }).optional(),

  /**
   * Origin system/lane the event came from (e.g. 'live', 'backfill', 'shopify',
   * 'pixel', 'internal'). Free-form provenance tag; mirrors the collector `source` use.
   */
  source: z.string().min(1).max(128).optional(),

  /**
   * Monotonic per-producer (or per-aggregate) sequence number for ordering/gap-detection.
   * Non-negative integer. null when the producer does not assign a sequence.
   */
  sequence: z.number().int().nonnegative().nullable().optional(),

  /**
   * Consent flags captured at the source as a nullable map of category → boolean
   * (DPDP lawful-basis categories — see consent/suppression.ts CONSENT_CATEGORIES).
   * Capture-only at this layer; enforcement is the can_contact() chokepoint, not here.
   * null = explicitly unknown; absent = not applicable to this event.
   */
  consent_flags: z.record(z.string(), z.boolean()).nullable().optional(),

  /**
   * Canonical alias of `event_name` — the registry schema name (dot-path, no version).
   * Kept in lockstep with event_name; present so registry-driven consumers can key off a
   * stable name field even where event_name is narrowed to a literal in a subtype.
   */
  schema_name: z.string().min(1).max(128).optional(),
});

export type EventEnvelopeBase = z.infer<typeof EventEnvelopeBaseSchema>;

// ── 1. user.registered ───────────────────────────────────────────────────────
// Emitted: after app_user insert + verification token issued.
// brand_id carries organization_id (user may not have a brand yet).

/** @public documented event payload contract (composed into UserRegisteredEventSchema below) */
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

/** @public documented event payload contract (composed into UserLoggedInEventSchema below) */
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

/** @public documented event payload contract (composed into WorkspaceCreatedEventSchema below) */
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

/** @public documented event payload contract (composed into BrandCreatedEventSchema below) */
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

/** @public documented event payload contract (composed into UserInvitedEventSchema below) */
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

/** @public documented event payload contract (composed into ConnectorConnectedEventSchema below) */
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

/** @public documented event payload contract (composed into ConnectorSyncStartedEventSchema below) */
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

/** @public documented event payload contract (composed into PixelInstalledEventSchema below) */
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

/** @public documented event payload contract (composed into PixelVerifiedEventSchema below) */
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
