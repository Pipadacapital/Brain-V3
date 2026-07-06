// SPEC: 0.5
/**
 * @brain/platform-flags — per-brand feature flags (Redis-backed, DEFAULT OFF, fail-closed).
 *
 * Public surface:
 *   PLATFORM_FLAGS / PlatformFlag / ALL_PLATFORM_FLAGS / isKnownFlag  — the typed registry
 *   createFlagService / FlagService / FlagStorePort                    — domain (port side)
 *   RedisFlagStoreAdapter / RedisFlagClient                            — infrastructure adapter
 *
 * Key shape: `{brand_id}:flag:{flag_name}` (built ONLY via tenant-context flagKey()).
 * Python twin for Spark jobs: db/iceberg/spark/_platform_flags.py (same keys, same
 * fail-closed semantics).
 */

export {
  PLATFORM_FLAGS,
  ALL_PLATFORM_FLAGS,
  isKnownFlag,
  type PlatformFlag,
  type FlagDefinition,
} from './registry.js';
export {
  createFlagService,
  type FlagService,
  type FlagState,
  type FlagStorePort,
  type CreateFlagServiceOptions,
} from './domain/flag-service.js';
export { RedisFlagStoreAdapter, type RedisFlagClient } from './infrastructure/redis-flag-store.js';
