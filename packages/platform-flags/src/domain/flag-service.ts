// SPEC: 0.5
/**
 * @brain/platform-flags — domain flag service (hexagonal PORT side).
 *
 * ── SEMANTICS (all load-bearing) ─────────────────────────────────────────────
 *  DEFAULT OFF   : a flag with no stored value is DISABLED. Only the literal
 *                  stored string 'true' enables — anything else (absent, 'false',
 *                  garbage) reads disabled.
 *  FAIL-CLOSED   : ANY store error (Redis down, timeout) → false → pre-wave
 *                  behavior. A flag read can never throw into a request path.
 *  TENANT-FIRST  : keys are `{brand_id}:flag:{name}` via the sanctioned
 *                  flagKey() builder (@brain/tenant-context, NN-7). Brand A's
 *                  flag state can never affect brand B by construction.
 *  LOCAL TTL     : reads are memoized in-process for ~10s so hot paths (pixel
 *                  ingest, stream-worker consumers) don't hit Redis per event.
 *                  Convergence bound after setFlag on OTHER instances = TTL.
 *
 * ── HEXAGONAL ────────────────────────────────────────────────────────────────
 * This module is pure domain logic: NO ioredis (or any driver) import. The
 * FlagStorePort is implemented by infrastructure/redis-flag-store.ts; the
 * composition root (apps/core/src/main.ts) injects the shared Redis client.
 */

import { flagKey } from '@brain/tenant-context';
import { PLATFORM_FLAGS, ALL_PLATFORM_FLAGS, isKnownFlag, type PlatformFlag } from '../registry.js';

// ── PORT ──────────────────────────────────────────────────────────────────────

/**
 * Driver-agnostic flag store port. Keys are fully-built (brand-first) — the
 * store never composes keys itself.
 */
export interface FlagStorePort {
  /** Raw stored value for a key, or null when unset. */
  get(key: string): Promise<string | null>;
  /** Durably store a value for a key (no TTL — flags persist until changed). */
  set(key: string, value: string): Promise<void>;
}

// ── SERVICE ───────────────────────────────────────────────────────────────────

export interface FlagState {
  flag: PlatformFlag;
  enabled: boolean;
  wave: string;
  spec: string;
  description: string;
}

export interface FlagService {
  /**
   * Is `flag` enabled for `brandId`?
   * DEFAULT OFF; FAIL-CLOSED (store error → false); unknown flag → false; ~10s
   * in-process cache. Never throws.
   */
  isFlagEnabled(brandId: string, flag: PlatformFlag): Promise<boolean>;
  /**
   * ADMIN: durably set a flag for ONE brand. Throws on unknown flag / missing
   * brandId / store failure (an admin write must not fail silently).
   * Updates this instance's local cache immediately; other instances converge
   * within the local TTL (~10s).
   */
  setFlag(brandId: string, flag: PlatformFlag, enabled: boolean): Promise<void>;
  /** ADMIN: every registered flag with its current state for one brand. */
  listFlags(brandId: string): Promise<FlagState[]>;
}

export interface CreateFlagServiceOptions {
  store: FlagStorePort;
  /** In-process read-cache TTL in ms (default 10_000). 0 disables the cache (tests). */
  localTtlMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

/** The stored string that means ENABLED. Everything else is disabled. */
const ENABLED_VALUE = 'true';
const DISABLED_VALUE = 'false';
const DEFAULT_LOCAL_TTL_MS = 10_000;

export function createFlagService(options: CreateFlagServiceOptions): FlagService {
  const { store } = options;
  const localTtlMs = options.localTtlMs ?? DEFAULT_LOCAL_TTL_MS;
  const now = options.now ?? Date.now;

  /** key → { enabled, freshUntil }. Failure results are cached too (a down Redis
   *  is not hammered per event; recovery lag is bounded by the same TTL). */
  const localCache = new Map<string, { enabled: boolean; freshUntil: number }>();

  function cachePut(key: string, enabled: boolean): void {
    if (localTtlMs <= 0) return;
    localCache.set(key, { enabled, freshUntil: now() + localTtlMs });
  }

  async function isFlagEnabled(brandId: string, flag: PlatformFlag): Promise<boolean> {
    // Fail-closed on bad inputs — never throw from a read path.
    if (!brandId || !isKnownFlag(flag)) return false;

    let key: string;
    try {
      key = flagKey({ brandId, flag });
    } catch {
      return false; // separator-injection etc. — closed.
    }

    const cached = localCache.get(key);
    if (cached && cached.freshUntil > now()) return cached.enabled;

    let enabled = false;
    try {
      enabled = (await store.get(key)) === ENABLED_VALUE;
    } catch {
      enabled = false; // FAIL-CLOSED: Redis down → pre-wave behavior.
    }
    cachePut(key, enabled);
    return enabled;
  }

  async function setFlag(brandId: string, flag: PlatformFlag, enabled: boolean): Promise<void> {
    if (!brandId) throw new Error('[platform-flags] setFlag: brandId is required');
    if (!isKnownFlag(flag)) {
      throw new Error(`[platform-flags] setFlag: unknown flag "${String(flag)}" — add it to the registry first`);
    }
    const key = flagKey({ brandId, flag }); // throws on separator injection — intended for a write.
    // Write 'false' explicitly (not DEL) so an audit of the keyspace distinguishes
    // "deliberately disabled" from "never configured". Both READ as disabled.
    await store.set(key, enabled ? ENABLED_VALUE : DISABLED_VALUE);
    cachePut(key, enabled);
  }

  async function listFlags(brandId: string): Promise<FlagState[]> {
    return Promise.all(
      ALL_PLATFORM_FLAGS.map(async (flag) => {
        const def = PLATFORM_FLAGS[flag];
        return {
          flag,
          enabled: await isFlagEnabled(brandId, flag),
          wave: def.wave,
          spec: def.spec,
          description: def.description,
        };
      }),
    );
  }

  return { isFlagEnabled, setFlag, listFlags };
}
