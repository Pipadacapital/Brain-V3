// SPEC: E
/**
 * @brain/ai-features — the AI Feature Layer SCHEMA CONTRACT (Wave E, scaffold-only).
 *
 * This module is the TYPED, store-agnostic contract for the point-in-time (PIT) feature
 * layer described in PLAN-OF-RECORD §PART 6.E. It is CONTRACT ONLY: types + documented
 * invariants. There is NO computation, NO materialization, NO embedding here (deferred —
 * see CONTRACT-E.md §Deferred). Every compute-shaped entrypoint in this package is a
 * NotImplemented stub behind the `features.online_serving` flag.
 *
 * ── AMD-19 POSTURE (feature store vs the "features are RUNTIME" invariant) ──────────────
 * CLAUDE.md + tools/lint/v4-naming-guard.sh (R3) forbid a permanent feature-precompute
 * table (no `feature_customer_daily`, no `brain_feature` write). AMD-19 defers the choice
 * to E-scaffold time and mandates the contract be written STORE-AGNOSTIC. This package
 * therefore takes posture **R2 (as-of over Silver/Gold, no new precompute table)**:
 *   • The `gold_ai_features` EAV shape below is a *logical schema contract*, expressed as a
 *     documented DDL (see CONTRACT-E.md) + these TS row types — NOT a DDL file that the
 *     refresh loop would create, and NOT registered in db/iceberg/spark. It trips no guard.
 *   • Training reads resolve features by an AS-OF JOIN over the Silver/Gold spine at
 *     `event_timestamp` (see `AsOfFeatureQuery`), NEVER "latest" — the discipline is the
 *     load-bearing requirement, not the storage.
 *   • If a physical offline store is later sanctioned, it is an ADDITIVE decision recorded
 *     as an amendment + a named allowlist entry in the guard — out of scope for scaffolding.
 *
 * NOTE: a WIDE current-state serving mart `gold_ai_features` already ships
 * (db/iceberg/spark/gold/gold_ai_features.py → brain_serving.mv_gold_ai_features, read by
 * @brain/metric-engine getAiFeatures). That is a RUNTIME Silver fold, a DIFFERENT artifact
 * from this EAV PIT contract, and is left untouched. CONTRACT-E.md §Naming reconciles them.
 */

/**
 * The entity a feature describes. `brand_id`-scoped in every case (§0.5: brand_id first).
 * Matches the Wave-D semantic entity families (semantic_customer / _product / _campaign).
 */
export type FeatureEntityType = 'customer' | 'product' | 'campaign';
export const FEATURE_ENTITY_TYPES: readonly FeatureEntityType[] = [
  'customer',
  'product',
  'campaign',
] as const;

export function isFeatureEntityType(v: unknown): v is FeatureEntityType {
  return typeof v === 'string' && (FEATURE_ENTITY_TYPES as readonly string[]).includes(v);
}

/**
 * The declared physical type of a feature value. The stored `feature_value` is a TYPED
 * UNION discriminated by `dtype` — never a blended/coerced scalar.
 *  - `double`  : real-valued score/ratio (derived from integer inputs; ratios only, §1.2).
 *  - `long`    : integer count / MINOR-unit money (money carries a sibling currency, §1.2 —
 *                a money feature declares `currency` on its definition; see FeatureDefinition).
 *  - `string`  : categorical / label.
 *  - `vector`  : embedding (DEFERRED — no embedding computation in this wave).
 */
export type FeatureDtype = 'double' | 'long' | 'string' | 'vector';
export const FEATURE_DTYPES: readonly FeatureDtype[] = ['double', 'long', 'string', 'vector'] as const;

export function isFeatureDtype(v: unknown): v is FeatureDtype {
  return typeof v === 'string' && (FEATURE_DTYPES as readonly string[]).includes(v);
}

/**
 * The typed feature value union — discriminated by `dtype`. The `vector` arm is present in
 * the contract (schema completeness) but its PRODUCTION is deferred; a serving path must
 * never synthesize one in this wave.
 */
export type FeatureValue =
  | { readonly dtype: 'double'; readonly double: number }
  | { readonly dtype: 'long'; readonly long: bigint }
  | { readonly dtype: 'string'; readonly string: string }
  | { readonly dtype: 'vector'; readonly vector: readonly number[] };

/**
 * One PIT feature row — the logical `gold_ai_features` grain (EAV, point-in-time).
 *
 * Logical DDL (documented, NOT materialized — see AMD-19 posture + CONTRACT-E.md):
 *
 *   gold_ai_features (
 *     brand_id           string     NOT NULL,   -- §0.5: brand_id FIRST, in the PK
 *     entity_type        string     NOT NULL,   -- customer | product | campaign
 *     entity_id          string     NOT NULL,   -- brain_id / sku / campaign_id (brand-scoped)
 *     feature_name       string     NOT NULL,   -- registry key (packages/ai-features/features/*.yaml)
 *     feature_value      <typed>    NOT NULL,    -- typed union double|long|string|vector (never blended)
 *     currency_code      string,                 -- sibling for `long` MONEY features only (§1.2), else null
 *     event_timestamp    timestamp  NOT NULL,    -- VALID time: when the fact became true (AS-OF key)
 *     created_timestamp  timestamp  NOT NULL,    -- SYSTEM time: when the row was written (audit only)
 *     feature_version    string     NOT NULL     -- feature-definition version (registry-pinned)
 *   )
 *   PRIMARY KEY (brand_id, entity_type, entity_id, feature_name, feature_version, event_timestamp)
 *
 * Point-in-time discipline (load-bearing, §PART 6.E / Feast-style): a TRAINING read selects,
 * per (entity, feature), the row with the GREATEST `event_timestamp` that is `<=` the label's
 * event time — an AS-OF JOIN. It NEVER selects `max(event_timestamp)` globally ("latest"):
 * that would leak future information into the training set. `created_timestamp` is audit/system
 * time only and is NEVER a join key.
 */
export interface AiFeatureRow {
  readonly brandId: string;
  readonly entityType: FeatureEntityType;
  readonly entityId: string;
  readonly featureName: string;
  readonly value: FeatureValue;
  /** Sibling ISO-4217 currency — present iff this is a `long` MONEY feature (§1.2); else null. */
  readonly currencyCode: string | null;
  /** VALID time — when the fact became true. The ONLY sanctioned as-of join key. */
  readonly eventTimestamp: string;
  /** SYSTEM time — when the row was written. Audit only; NEVER an as-of join key. */
  readonly createdTimestamp: string;
  /** The pinned feature-definition version this value was produced under. */
  readonly featureVersion: string;
}

/**
 * The sanctioned shape of a training-time AS-OF request. This is a CONTRACT type only — the
 * resolver that fulfils it (over the Silver/Gold spine, AMD-19 posture R2) is DEFERRED.
 * `asOf` is REQUIRED: there is no "latest" convenience overload, by design.
 */
export interface AsOfFeatureQuery {
  readonly brandId: string;
  readonly entityType: FeatureEntityType;
  readonly entityIds: readonly string[];
  readonly featureNames: readonly string[];
  /** The label/event time. Each feature resolves to greatest event_timestamp <= asOf. REQUIRED. */
  readonly asOf: string;
}

// ── ONLINE SERVING CONTRACT (Redis) ─────────────────────────────────────────────────────
/**
 * The online-serving low-latency store is a Redis HASH per entity:
 *
 *   KEY   : `{brand_id}:feat:{entity_type}:{entity_id}`   (brand_id FIRST, §0.5; built ONLY
 *           via the sanctioned tenant-context key builder — never string-concatenated here)
 *   FIELD : feature_name
 *   VALUE : the serialized typed feature value (dtype-tagged)
 *
 * The online hash holds the CURRENT ("latest") materialized value for inference — this is the
 * ONE place "latest" is correct, because online inference is a now-query, not a training read.
 * It is a CACHE, not truth (mirrors the A.4 touchpoint cache): the offline as-of contract is
 * authoritative. Crypto-shred: the key is brand+subject scoped, so erasure DELetes it in the
 * re-projection step (registered in the shred manifest). MATERIALIZATION IS DEFERRED — nothing
 * in this wave writes these keys.
 */
export const ONLINE_FEATURE_KEY_PREFIX = 'feat' as const;

/** The Redis key TEMPLATE for documentation/tests. Real keys MUST be built via tenant-context. */
export function onlineFeatureKeyTemplate(entityType: FeatureEntityType): string {
  return `{brand_id}:${ONLINE_FEATURE_KEY_PREFIX}:${entityType}:{entity_id}`;
}
