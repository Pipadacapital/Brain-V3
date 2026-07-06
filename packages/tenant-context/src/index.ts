/**
 * @brain/tenant-context — Tenant-scoped utilities.
 *
 * THE SOLE SANCTIONED Redis key builder is brandKey(). Raw key construction
 * outside this function is lint-banned (NN-7, I-S01).
 *
 * Key shape:
 *   brain:v1:brand:{brandId}:metric:{metricId}:v{version}:g:{grain}:f:{filtersHash}:at:{asOf}
 *
 * All six segments are required — an incomplete key risks cross-brand
 * data co-location if a segment is undefined and coerces to "undefined".
 */

// ── BrandKey ─────────────────────────────────────────────────────────────────

export interface BrandKeyParams {
  /** UUID of the brand (tenant key). */
  brandId: string;
  /** The metric identifier from the metric registry. */
  metricId: string;
  /** Metric schema version (integer). */
  version: number;
  /**
   * Stable hash of the filter set applied to this metric snapshot.
   * Use a consistent serialisation (e.g. sorted JSON => sha256 first 8 hex chars).
   */
  filtersHash: string;
  /**
   * Time grain of the aggregation: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'ltv'.
   */
  grain: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'ltv';
  /**
   * The "as of" date for which this snapshot was computed — ISO-8601 date string (YYYY-MM-DD).
   * This anchors the cache entry to a specific snapshot and prevents stale reads.
   */
  asOf: string;
}

/**
 * Build a tenant-scoped Redis key for a metric snapshot.
 *
 * This is the ONLY sanctioned way to build Redis keys in the Brain codebase.
 * Raw key construction ('brand:' + id + ':...') is banned by NN-7 lint.
 *
 * Key format (stable, versioned):
 *   brain:v1:brand:{brandId}:metric:{metricId}:v{version}:g:{grain}:f:{filtersHash}:at:{asOf}
 *
 * The "brain:v1:" prefix namespaces all Brain keys and allows clean key-space
 * migrations without touching application code.
 *
 * @throws {Error} If any required parameter is missing, empty, or contains ":" (separator).
 */
export function brandKey(params: BrandKeyParams): string {
  const { brandId, metricId, version, filtersHash, grain, asOf } = params;

  // Validate — every segment must be non-empty (undefined would silently corrupt the key)
  if (!brandId) throw new Error('[tenant-context] brandKey: brandId is required');
  if (!metricId) throw new Error('[tenant-context] brandKey: metricId is required');
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new Error('[tenant-context] brandKey: version must be a positive integer');
  if (!filtersHash) throw new Error('[tenant-context] brandKey: filtersHash is required');
  if (!grain) throw new Error('[tenant-context] brandKey: grain is required');
  if (!asOf) throw new Error('[tenant-context] brandKey: asOf is required');

  // Guard against accidental separator injection in segment values
  for (const [name, val] of Object.entries({ brandId, metricId, filtersHash, grain, asOf })) {
    if (String(val).includes(':')) {
      throw new Error(
        `[tenant-context] brandKey: "${name}" must not contain ":" (would break key parsing)`,
      );
    }
  }

  return `brain:v1:brand:${brandId}:metric:${metricId}:v${version}:g:${grain}:f:${filtersHash}:at:${asOf}`;
}

// ── Rate-limit key ────────────────────────────────────────────────────────────

export interface RateLimitKeyParams {
  /** UUID of the brand. */
  brandId: string;
  /** The rate-limited resource (e.g. 'api:ingest', 'mcp:query'). */
  resource: string;
  /** Window start bucket (e.g. Unix epoch minute: Math.floor(Date.now() / 60_000)). */
  windowBucket: number;
}

/**
 * Build a rate-limit counter key for a brand + resource + time window.
 * Also sanctioned (no raw key construction needed for rate-limit paths).
 */
export function rateLimitKey(params: RateLimitKeyParams): string {
  const { brandId, resource, windowBucket } = params;
  if (!brandId) throw new Error('[tenant-context] rateLimitKey: brandId is required');
  if (!resource) throw new Error('[tenant-context] rateLimitKey: resource is required');
  if (typeof windowBucket !== 'number' || !Number.isInteger(windowBucket))
    throw new Error('[tenant-context] rateLimitKey: windowBucket must be an integer');

  return `brain:v1:rl:brand:${brandId}:resource:${resource}:w:${windowBucket}`;
}

// ── Feature-flag key (SPEC: 0.5) ──────────────────────────────────────────────

export interface FlagKeyParams {
  /** UUID of the brand (tenant key — MUST be the first key segment). */
  brandId: string;
  /** The flag name from the @brain/platform-flags registry (e.g. 'stitch.v2'). */
  flag: string;
}

/**
 * Build a per-brand feature-flag key: `{brand_id}:flag:{flag_name}`.
 *
 * SPEC: 0.5 — brand_id is the FIRST segment of every Redis key. The Python twin
 * (db/iceberg/spark/_platform_flags.py) builds the identical key — keep in lockstep.
 * Sanctioned builder per the no-raw-redis-key lint rule (NN-7).
 *
 * @throws {Error} If a segment is missing or contains ":" (separator injection).
 */
export function flagKey(params: FlagKeyParams): string {
  const { brandId, flag } = params;
  if (!brandId) throw new Error('[tenant-context] flagKey: brandId is required');
  if (!flag) throw new Error('[tenant-context] flagKey: flag is required');
  for (const [name, val] of Object.entries({ brandId, flag })) {
    if (String(val).includes(':')) {
      throw new Error(
        `[tenant-context] flagKey: "${name}" must not contain ":" (would break key parsing)`,
      );
    }
  }
  return `${brandId}:flag:${flag}`;
}

// ── Session key ───────────────────────────────────────────────────────────────

export interface SessionKeyParams {
  /** UUID of the brand. */
  brandId: string;
  /** Opaque session token (the hash, not the raw token). */
  sessionTokenHash: string;
}

/**
 * Build a session store key. Use this instead of constructing raw keys.
 */
export function sessionKey(params: SessionKeyParams): string {
  const { brandId, sessionTokenHash } = params;
  if (!brandId) throw new Error('[tenant-context] sessionKey: brandId is required');
  if (!sessionTokenHash)
    throw new Error('[tenant-context] sessionKey: sessionTokenHash is required');
  return `brain:v1:session:brand:${brandId}:tok:${sessionTokenHash}`;
}
