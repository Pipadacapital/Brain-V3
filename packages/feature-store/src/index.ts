/**
 * @brain/feature-store — the Brain feature layer (re-platform Phase F).
 *
 * A thin, TS-everywhere feature store: a feature-definition registry, a Redis ONLINE store for
 * low-latency serving, and an OFFLINE materializer that computes features from the Gold layer
 * (gold_customer_360) and writes them online. ONE definition computes the value, used by both the
 * offline materialization and (by construction) online serving → no train/serve skew (offline/online
 * parity). Iceberg offline feature tables + Python ML (embeddings/learned scores) are later sub-slices;
 * these first features are DETERMINISTIC (no model) over Gold. Per-brand isolation: brand_id is the
 * first key segment of every online key — reads/writes are brand-scoped.
 *
 * Freshness contract (gap: feature-materialization-scheduling-eval-gate):
 *   - Every online feature key carries a Redis TTL of FEATURE_TTL_SECONDS (25 hours) so stale
 *     features EXPIRE and are not silently served.
 *   - A sentinel key `feat:sentinel:{brand_id}:last_materialized_at` is written on every
 *     materialization run with the ISO timestamp + the same TTL.
 *   - checkFeatureFreshness() reads the sentinel and raises a FeatureStaleError when the sentinel is
 *     absent (TTL expired or never written) or when the materialization lag exceeds
 *     FEATURE_FRESHNESS_SLO_SECONDS (default 26 hours, i.e. one missed hourly run + buffer).
 *   - This is the offline/online parity alarm surface: the cron job sentinel must be within the SLO
 *     window or the serving path surfaces staleness to callers (rather than silently serving stale data).
 */
import { Redis } from 'ioredis';

/** A Gold customer row (gold_customer_360) — the input to customer-entity features. */
export interface Customer360Row {
  brain_id: string;
  lifetime_value_minor: number;
  lifetime_orders: number;
  delivered_orders: number;
  rto_orders: number;
}

export interface FeatureDefinition {
  /** Feature name (the serving key segment). */
  readonly name: string;
  /** Entity the feature is keyed by. */
  readonly entity: 'customer';
  /** Deterministic compute from a Gold row → the feature value (the SINGLE source of truth). */
  readonly compute: (row: Customer360Row) => number;
}

/** The customer feature definitions (deterministic v1; ML/learned features come via the Python service). */
export const CUSTOMER_FEATURES: readonly FeatureDefinition[] = [
  { name: 'ltv_minor', entity: 'customer', compute: (r) => r.lifetime_value_minor },
  {
    name: 'purchase_probability',
    entity: 'customer',
    // deterministic proxy: delivered-order rate, clamped to [0,1]
    compute: (r) => (r.lifetime_orders > 0 ? Math.min(1, r.delivered_orders / r.lifetime_orders) : 0),
  },
  {
    name: 'rto_risk',
    entity: 'customer',
    compute: (r) => (r.lifetime_orders > 0 ? r.rto_orders / r.lifetime_orders : 0),
  },
];

export interface FeatureValue {
  value: number;
  computedAt: string;
}

/**
 * TTL applied to every online feature key + the freshness sentinel (25 hours).
 * One full materialization cadence (hourly at :40) plus a ~1-hour buffer before stale features expire
 * and the sentinel alarm fires. Setting this < the materialization interval means features would
 * self-expire between runs — never set it shorter than the cron period.
 */
export const FEATURE_TTL_SECONDS = 25 * 3600; // 25 h

/**
 * Freshness SLO: the materialization sentinel must be no older than this many seconds (26 hours).
 * Exceeding this means at least one full hourly run was missed; the serving path surfaces a FeatureStaleError.
 */
export const FEATURE_FRESHNESS_SLO_SECONDS = 26 * 3600; // 26 h

/** Thrown when the freshness sentinel is absent or the materialization lag exceeds the SLO. */
export class FeatureStaleError extends Error {
  constructor(brandId: string, lagSeconds: number | null) {
    const detail =
      lagSeconds === null
        ? 'sentinel absent (features may have expired or materialization never ran)'
        : `materialization lag ${lagSeconds}s exceeds SLO ${FEATURE_FRESHNESS_SLO_SECONDS}s`;
    super(`Feature freshness SLO violated for brand ${brandId}: ${detail}`);
    this.name = 'FeatureStaleError';
  }
}

/** Redis-backed online feature store. Key = feat:{brand_id}:{feature}:{entity_id} (brand-scoped). */
export class RedisOnlineStore {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url);
  }

  private key(brandId: string, feature: string, entityId: string): string {
    return `feat:${brandId}:${feature}:${entityId}`;
  }

  /** Sentinel key — presence + value prove a materialization ran within the TTL window. */
  private sentinelKey(brandId: string): string {
    return `feat:sentinel:${brandId}:last_materialized_at`;
  }

  /**
   * Write an online feature value with the canonical TTL.
   * EX = absolute TTL (seconds) — the feature expires after FEATURE_TTL_SECONDS even if never read.
   * This ensures stale features are not silently served after the materialization falls behind.
   */
  async set(brandId: string, entityId: string, feature: string, value: number, computedAt: string): Promise<void> {
    await this.redis.set(
      this.key(brandId, feature, entityId),
      JSON.stringify({ value, computedAt }),
      'EX',
      FEATURE_TTL_SECONDS,
    );
  }

  async get(brandId: string, entityId: string, feature: string): Promise<FeatureValue | null> {
    const s = await this.redis.get(this.key(brandId, feature, entityId));
    return s ? (JSON.parse(s) as FeatureValue) : null;
  }

  /**
   * Write the materialization sentinel. Called AFTER a successful materialization run.
   * The sentinel carries the same TTL as individual feature keys: if materialization stops running
   * the sentinel will expire, causing checkFeatureFreshness() to raise a FeatureStaleError.
   */
  async writeSentinel(brandId: string, materializedAt: string): Promise<void> {
    await this.redis.set(this.sentinelKey(brandId), materializedAt, 'EX', FEATURE_TTL_SECONDS);
  }

  /**
   * Read the freshness sentinel. Returns the ISO timestamp written by the last materialization run,
   * or null if the sentinel is absent (expired or never written).
   */
  async readSentinel(brandId: string): Promise<string | null> {
    return this.redis.get(this.sentinelKey(brandId));
  }

  /**
   * Check offline/online feature parity via the freshness sentinel.
   * Throws FeatureStaleError when:
   *   (a) the sentinel is absent → features may have expired (TTL elapsed, no materialization), or
   *   (b) the materialization lag exceeds FEATURE_FRESHNESS_SLO_SECONDS.
   *
   * This is the parity alarm surface: callers (serving path + health checks) invoke this before
   * returning features, surfacing staleness rather than silently serving expired/stale values.
   *
   * @effort deterministic — Redis GET + arithmetic, no model call.
   */
  async checkFeatureFreshness(brandId: string, nowIso?: string): Promise<void> {
    const sentinel = await this.readSentinel(brandId);
    if (sentinel === null) {
      throw new FeatureStaleError(brandId, null);
    }
    const now = new Date(nowIso ?? new Date().toISOString()).getTime();
    const sentinelTs = new Date(sentinel).getTime();
    const lagSeconds = Math.floor((now - sentinelTs) / 1000);
    if (lagSeconds > FEATURE_FRESHNESS_SLO_SECONDS) {
      throw new FeatureStaleError(brandId, lagSeconds);
    }
  }

  /** Delete all online features for a brand (test cleanup / brand offboard). */
  async purgeBrand(brandId: string): Promise<void> {
    const keys = await this.redis.keys(`feat:${brandId}:*`);
    const sentinel = this.sentinelKey(brandId);
    const sentinelInKeys = await this.redis.keys(`feat:sentinel:${brandId}:*`);
    const allKeys = [...keys, ...sentinelInKeys, sentinel].filter((v, i, a) => a.indexOf(v) === i);
    if (allKeys.length > 0) await this.redis.del(...allKeys);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

/**
 * Offline → online materialization for customer features. Computes every CUSTOMER_FEATURES value from
 * the given Gold rows and writes them to the online store with a TTL (FEATURE_TTL_SECONDS). Writes the
 * freshness sentinel after all feature writes succeed. Idempotent (overwrites per key). Decoupled
 * from the warehouse client — the caller supplies the rows (read from gold_customer_360).
 *
 * The sentinel write is the last step: if the sentinel is present, a complete run finished within the
 * TTL window. If the job aborts mid-run the sentinel is not written (or the prior sentinel remains),
 * and checkFeatureFreshness() will alarm when the prior sentinel expires.
 */
export async function materializeCustomerFeatures(
  brandId: string,
  rows: readonly Customer360Row[],
  store: RedisOnlineStore,
  computedAt: string,
): Promise<{ customers: number; featuresWritten: number }> {
  let featuresWritten = 0;
  for (const row of rows) {
    for (const def of CUSTOMER_FEATURES) {
      await store.set(brandId, row.brain_id, def.name, def.compute(row), computedAt);
      featuresWritten++;
    }
  }
  // Write the sentinel AFTER all feature keys are written (sentinel = "run complete").
  await store.writeSentinel(brandId, computedAt);
  return { customers: rows.length, featuresWritten };
}
