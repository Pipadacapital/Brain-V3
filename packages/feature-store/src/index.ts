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

/** Redis-backed online feature store. Key = feat:{brand_id}:{feature}:{entity_id} (brand-scoped). */
export class RedisOnlineStore {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url);
  }

  private key(brandId: string, feature: string, entityId: string): string {
    return `feat:${brandId}:${feature}:${entityId}`;
  }

  async set(brandId: string, entityId: string, feature: string, value: number, computedAt: string): Promise<void> {
    await this.redis.set(this.key(brandId, feature, entityId), JSON.stringify({ value, computedAt }));
  }

  async get(brandId: string, entityId: string, feature: string): Promise<FeatureValue | null> {
    const s = await this.redis.get(this.key(brandId, feature, entityId));
    return s ? (JSON.parse(s) as FeatureValue) : null;
  }

  /** Delete all online features for a brand (test cleanup / brand offboard). */
  async purgeBrand(brandId: string): Promise<void> {
    const keys = await this.redis.keys(`feat:${brandId}:*`);
    if (keys.length > 0) await this.redis.del(...keys);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

/**
 * Offline → online materialization for customer features. Computes every CUSTOMER_FEATURES value from
 * the given Gold rows and writes them to the online store. Idempotent (overwrites per key). Decoupled
 * from the warehouse client — the caller supplies the rows (read from gold_customer_360).
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
  return { customers: rows.length, featuresWritten };
}
