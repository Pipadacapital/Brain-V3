/**
 * @brain/feature-flags — Per-brand ops kill-switches + beta gating (ADR-010).
 *
 * Sprint-0: stub interface. No LaunchDarkly-style targeting.
 * The rollback drill (EC8) uses flag-off to gate a feature per brand.
 *
 * Pattern: a flag is either ON (enabled) or OFF (disabled) for a brand.
 * Flags are scoped to a brand_id — there are no global flags.
 *
 * Implementation in M1: backed by Redis (per-brand key, TTL = 1 hour default).
 * Sprint-0: in-memory stub sufficient for unit tests.
 */

// ── Flag definition ───────────────────────────────────────────────────────────

/** Known feature flag keys. Extend this union as new flags are introduced. */
export type FeatureFlagKey =
  | 'collector.ingest.enabled'
  | 'analytics.dashboard.enabled'
  | 'notifications.email.enabled'
  | 'notifications.push.enabled'
  | 'rollback.collector.v2'
  | string; // Open-ended for M1+

// ── Flag reader interface ─────────────────────────────────────────────────────

export interface FeatureFlagReader {
  /**
   * Check if a feature flag is enabled for a given brand.
   *
   * @param brandId - The brand to check the flag for.
   * @param key - The feature flag key.
   * @returns true if the flag is enabled; false if disabled or not set (fail-closed).
   */
  isEnabled(brandId: string, key: FeatureFlagKey): Promise<boolean>;
}

// ── In-memory stub (Sprint-0) ─────────────────────────────────────────────────

/**
 * In-memory feature flag reader for Sprint-0.
 * Default: all flags are ON (enabled) unless explicitly set to false.
 * Used in unit tests to toggle flags without Redis.
 */
export class InMemoryFlagReader implements FeatureFlagReader {
  private readonly flags = new Map<string, boolean>();

  /**
   * Set a flag override for testing.
   * @example
   *   flags.setFlag(brandId, 'collector.ingest.enabled', false);
   */
  setFlag(brandId: string, key: FeatureFlagKey, enabled: boolean): void {
    this.flags.set(`${brandId}:${key}`, enabled);
  }

  async isEnabled(brandId: string, key: FeatureFlagKey): Promise<boolean> {
    const override = this.flags.get(`${brandId}:${key}`);
    if (override !== undefined) return override;
    // Default: enabled (open by default; explicit flag-off for kill-switch).
    return true;
  }
}

// ── Guard helper ──────────────────────────────────────────────────────────────

/**
 * Throw if a feature flag is disabled for the given brand.
 * Use this at the top of a request handler to implement kill-switches.
 *
 * @example
 *   await requireFlag(flags, brandId, 'collector.ingest.enabled');
 */
export async function requireFlag(
  reader: FeatureFlagReader,
  brandId: string,
  key: FeatureFlagKey,
): Promise<void> {
  const enabled = await reader.isEnabled(brandId, key);
  if (!enabled) {
    throw new FeatureFlagDisabledError(brandId, key);
  }
}

export class FeatureFlagDisabledError extends Error {
  readonly brandId: string;
  readonly flagKey: FeatureFlagKey;

  constructor(brandId: string, flagKey: FeatureFlagKey) {
    super(`[feature-flags] Flag "${flagKey}" is disabled for brand ${brandId}`);
    this.name = 'FeatureFlagDisabledError';
    this.brandId = brandId;
    this.flagKey = flagKey;
  }
}
