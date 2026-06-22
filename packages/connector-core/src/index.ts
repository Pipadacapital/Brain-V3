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

export { ConnectorSyncStatus } from './domain/entities/ConnectorSyncStatus.js';
export type {
  ConnectorSyncStatusProps,
  SyncState,
} from './domain/entities/ConnectorSyncStatus.js';

export { ConnectorCursor } from './domain/entities/ConnectorCursor.js';
export type { ConnectorCursorProps } from './domain/entities/ConnectorCursor.js';

// ── Repository interfaces ──────────────────────────────────────────────────────
export type { IConnectorInstanceRepository } from './domain/repositories/IConnectorInstanceRepository.js';
export type { IConnectorSyncStatusRepository } from './domain/repositories/IConnectorSyncStatusRepository.js';
export type { IConnectorCursorRepository } from './domain/repositories/IConnectorCursorRepository.js';

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
} from './contracts/CanonicalEvent.js';

// ── Shared utils ───────────────────────────────────────────────────────────────
export { hashToUuidShaped } from './util/hash-to-uuid-shaped.js';
