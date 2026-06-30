/**
 * @brain/connector-core — the neutral connector platform kernel.
 *
 * The single source of truth for the connector base: provider-agnostic domain entities, the
 * repository interfaces over them, the unified IConnector lifecycle contract + ConnectorFactory,
 * the IMapper / CanonicalEvent contract, and the shared deterministic-id util.
 *
 * Every connector source and every mapper consumes from HERE (Single-Primitive Rule). The base
 * previously lived — accidentally — under sources/storefront/shopify/domain; that location now
 * keeps thin re-export shims pointing back to this package for backward compatibility.
 */

// ── Domain entities (provider-agnostic) ───────────────────────────────────────
export {
  ConnectorInstance,
  DEFAULT_ACCOUNT_KEY,
} from './domain/entities/ConnectorInstance.js';
export type {
  ConnectorInstanceProps,
  ConnectorStatus,
  HealthState,
  SafetyRating,
  HostValidator,
} from './domain/entities/ConnectorInstance.js';

export { AD_PLATFORM_PROVIDERS, isAdPlatformProvider } from './domain/ad-platform.js';
export type { AdPlatformProvider } from './domain/ad-platform.js';

export {
  BACKFILL_QUEUE_PROVIDERS,
  supportsBackfillQueue,
  INGESTION_BACKFILL_PROVIDERS,
  supportsIngestionBackfill,
  supportsHistoricalBackfill,
} from './domain/backfill-providers.js';
export type {
  BackfillQueueProvider,
  IngestionBackfillProvider,
} from './domain/backfill-providers.js';

export { ConnectorSyncStatus } from './domain/entities/ConnectorSyncStatus.js';
export type {
  ConnectorSyncStatusProps,
  SyncState,
} from './domain/entities/ConnectorSyncStatus.js';

export { ConnectorCursor } from './domain/entities/ConnectorCursor.js';
export type { ConnectorCursorProps } from './domain/entities/ConnectorCursor.js';

export { ResourceBackfillState } from './domain/entities/ResourceBackfillState.js';
export type {
  ResourceBackfillStateProps,
  ResourceBackfillStatus,
} from './domain/entities/ResourceBackfillState.js';

// ── Repository interfaces ──────────────────────────────────────────────────────
export type { IConnectorInstanceRepository } from './domain/repositories/IConnectorInstanceRepository.js';
export type { IConnectorSyncStatusRepository } from './domain/repositories/IConnectorSyncStatusRepository.js';
export type { IConnectorCursorRepository } from './domain/repositories/IConnectorCursorRepository.js';
export type { IResourceBackfillStateRepository } from './domain/repositories/IResourceBackfillStateRepository.js';

// ── Unified contracts ──────────────────────────────────────────────────────────
export type {
  IConnector,
  AuthResult,
  ValidationResult,
  HealthResult,
} from './contracts/IConnector.js';
export {
  ConnectorFactory,
  ConnectorNotRegisteredError,
} from './contracts/ConnectorFactory.js';
export type { ConnectorRegistration } from './contracts/ConnectorFactory.js';
export type {
  IMapper,
  MapContext,
} from './contracts/IMapper.js';
export type {
  CanonicalEvent,
  CanonicalMoney,
  CanonicalProvenance,
  CanonicalPreHashedIdentifiers,
} from './contracts/CanonicalEvent.js';

// ── Ingestion framework: manifest (resource registry) ────────────────────────────
export {
  TWO_YEARS_MS,
  UNBOUNDED_BACKFILL_WINDOW_MS,
  resolveBackfillFloor,
  getResource,
  backfillableResources,
  assertManifestValid,
} from './contracts/IngestionManifest.js';
export type {
  IngestionManifest,
  ResourceDescriptor,
  ResourceKind,
  CursorStrategy,
  DedupKeyStrategy,
} from './contracts/IngestionManifest.js';

// ── Ingestion framework: dedup (deterministic event-id) ──────────────────────────
export {
  DeterministicDedupKeyDeriver,
  deterministicDedupKeyDeriver,
  PrecomputedEventIdDeriver,
  precomputedEventIdDeriver,
  buildDedupNamespace,
} from './contracts/Dedup.js';
export type { IDedupKeyDeriver, DedupKeyInput } from './contracts/Dedup.js';

// ── Ingestion framework: no-loss (retry + DLQ) ───────────────────────────────────
export {
  deliverWithNoLoss,
  backoffDelayMs,
  DEFAULT_RETRY_POLICY,
} from './contracts/NoLoss.js';
export type {
  IEventSink,
  IDeadLetterSink,
  DeadLetterRecord,
  RetryPolicy,
  Sleeper,
  DeliveryOutcome,
} from './contracts/NoLoss.js';

// ── Ingestion framework: resumable chunked backfill driver ───────────────────────
export { runResumableBackfill } from './contracts/Backfill.js';
export type {
  IResourcePageFetcher,
  ResourcePage,
  FetchedRecord,
  CanonicalEventDraft,
  BackfillRunResult,
  BackfillStopReason,
} from './contracts/Backfill.js';

// ── Ingestion framework: per-connector manifests (resource registries) ───────────
export {
  SHIPROCKET_PROVIDER,
  SHIPROCKET_SHIPMENT_LIFECYCLE_RESOURCE,
  SHIPROCKET_INGESTION_MANIFEST,
} from './manifests/shiprocket.manifest.js';
export { GA4_INGESTION_MANIFEST } from './manifests/ga4.manifest.js';
export { GOOGLE_ADS_INGESTION_MANIFEST } from './manifests/google_ads.manifest.js';
export {
  META_PROVIDER,
  META_INSIGHTS_RESOURCE,
  META_INGESTION_MANIFEST,
} from './manifests/meta.manifest.js';
export {
  RAZORPAY_PROVIDER,
  RAZORPAY_SETTLEMENTS_PAYMENTS_RESOURCE,
  RAZORPAY_SETTLEMENTS_RESERVES_RESOURCE,
  RAZORPAY_SETTLEMENTS_ADJUSTMENTS_RESOURCE,
  RAZORPAY_INGESTION_MANIFEST,
} from './manifests/razorpay.manifest.js';

// ── Shared utils ───────────────────────────────────────────────────────────────
export { hashToUuidShaped } from './util/hash-to-uuid-shaped.js';
