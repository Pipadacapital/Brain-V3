/**
 * intelligence.api.v1.ts — the Brain V4 intelligence-layer contracts: the attribution-model PORT,
 * its enabled/registered-disabled registry, and the Gold data-product descriptor the IntelligenceJob
 * template + lineage build on.
 *
 * Zod is the source of truth (I-E01). This file is the TS-side mirror of two existing repo authorities,
 * and it ADDS no new attribution-model enum:
 *   - the attribution math + model set: packages/metric-engine/src/attribution-models.ts
 *     (AttributionModelId, WEIGHT_SCALE=1e8, computeWeightUnits, PER_JOURNEY_MODEL_IDS, data_driven=global).
 *   - the medallion mart descriptor: db/iceberg/spark/parity/mart_registry.py (MartSpec: name/layer/pk/
 *     money_columns/provisional). GoldDataProduct is the TS contract form of that Python MartSpec.
 *
 * INVARIANTS (NON-NEGOTIABLE — V4 rules + 02/05-architecture.md):
 *  - NO FLOAT for money OR weights. Credit weights are INTEGER 1e8-scaled units (bigint), summing to
 *    WEIGHT_SCALE EXACTLY (largest-remainder closes any residual). Money is bigint minor units + a sibling
 *    currency_code column (named, never blended, never a z.number()).
 *  - confidence is an INTEGER 0-100 (ConfidenceScoreSchema) — never a float, never an unbounded number.
 *  - brand_id is the implicit-first tenant key on every Gold product PK (V4 rule 5).
 *  - DEFERRED strategies are registered-DISABLED with an explicit NotImplementedYet marker and NEVER
 *    faked: a not-yet-built predictive model has a registry slot + a confidence-floor activation gate, but
 *    asking for its port throws NotImplementedYetError instead of returning a fabricated weight vector.
 */
import { z } from 'zod';

import { AttributionModelIdSchema, LifecycleStateSchema, MinorUnitsSchema } from './_money.js';
import type { AttributionModelId } from './_money.js';

// ── Shared intelligence primitives ────────────────────────────────────────────

/**
 * The medallion layer an Iceberg data product lives in. Mirrors the Spark namespaces
 * (brain_{bronze,silver,gold}_local). Most snap_* products are brain_silver; business-truth marts gold.
 */
export const MedallionLayerSchema = z.enum(['bronze', 'silver', 'gold']);
export type MedallionLayer = z.infer<typeof MedallionLayerSchema>;

/**
 * Confidence as an INTEGER 0-100 — the canonical confidence convention for every NEW intelligence output
 * (scores, predictive-model self-reported confidence, activation gates). This SUPERSEDES the legacy
 * float-fraction style ('1.000'/'0.700'/'0.400' in attribution-confidence.ts) for new V4 surfaces: an
 * integer percent, never a float, never unbounded. 100 = fully trusted; 0 = no confidence.
 */
export const ConfidenceScoreSchema = z.number().int().min(0).max(100);
export type ConfidenceScore = z.infer<typeof ConfidenceScoreSchema>;

/**
 * Weight scale: 1e8 hundred-millionths == the exact granularity of DECIMAL(9,8). Mirrors
 * metric-engine WEIGHT_SCALE (packages/metric-engine/src/attribution-models.ts). Every model's per-touch
 * weight units are integers (bigint) summing to WEIGHT_SCALE EXACTLY. No IEEE float ever touches a weight.
 */
export const WEIGHT_SCALE = 100_000_000n;

// ── 1. Attribution-model PORT + registry ──────────────────────────────────────

/**
 * The minimal touch projection the port needs — one resolved touch of a single journey, in conversion
 * order. Mirrors metric-engine AttributionTouch (camelCase: this is an in-process port, not a wire DTO).
 */
export interface AttributionTouchInput {
  /** Conversion-order sequence (1-based, carried verbatim from silver_touchpoint.touch_seq). */
  touchSeq: number;
}

/**
 * The attribution-model PORT. An implementation (in @brain/metric-engine, NEVER in contracts) maps an
 * ordered journey's touches to per-touch credit WEIGHTS in 1e8-scaled INTEGER units.
 *
 * CONTRACT of computeWeightUnits (the port form of metric-engine's free `computeWeightUnits`):
 *  - returns exactly one bigint per input touch, in the same order;
 *  - every unit is ≥ 0;
 *  - Σ over the returned units === WEIGHT_SCALE (1e8) EXACTLY (largest-remainder closes integer-division
 *    residual) — so a downstream largest-remainder apportionment over signed minor units sums to the
 *    order's realized revenue EXACTLY (no penny leak, sign-preserving);
 *  - empty input → [].
 * NO float, NO normalization-by-division of money — weights are integers, money is apportioned from them.
 */
export interface AttributionModelPort {
  /** The model id — reuses the EXISTING closed AttributionModelId set (no new enum). */
  readonly id: AttributionModelId;
  /** Per-touch credit weight in 1e8-scaled integer units (bigint[]); Σ === WEIGHT_SCALE exactly. */
  computeWeightUnits(touches: readonly AttributionTouchInput[]): bigint[];
}

/**
 * How a model derives its weights:
 *  - deterministic: a closed-form of a single journey's touches (first/last/linear/position_based/time_decay).
 *  - statistical:   weights LEARNED from the whole journey corpus (data_driven Markov removal-effect) —
 *                   GLOBAL, not per-journey (so it is NOT in metric-engine PER_JOURNEY_MODEL_IDS).
 *  - predictive:    a not-yet-built ML model (uplift/survival/Shapley) — registered DISABLED below.
 */
export const AttributionModelClassSchema = z.enum(['deterministic', 'statistical', 'predictive']);
export type AttributionModelClass = z.infer<typeof AttributionModelClassSchema>;

/** A first-class, ENABLED attribution model — backed by a real port implementation in metric-engine. */
export const EnabledAttributionModelSchema = z.object({
  /** Reuses the EXISTING AttributionModelIdSchema (no new enum) — one of the five built models. */
  id: AttributionModelIdSchema,
  status: z.literal('enabled'),
  model_class: AttributionModelClassSchema,
  /** true ⇔ weights are corpus-global (data_driven); false ⇔ per-journey closed-form. */
  global: z.boolean(),
});
export type EnabledAttributionModel = z.infer<typeof EnabledAttributionModelSchema>;

/**
 * A registered-but-DISABLED predictive model slot. `future_id` is NOT (yet) a member of
 * AttributionModelIdSchema — adding it to the enum is the act of building it. Until then the model is
 * documented, gated, and HONEST: it produces no weights (resolveAttributionModelPort throws), so the
 * system never fakes a predictive credit vector (V4 deferred-strategy rule).
 */
export const DisabledPredictiveModelSchema = z.object({
  /** The planned model id — deliberately NOT in AttributionModelIdSchema until implemented. */
  future_id: z.string().min(1),
  status: z.literal('disabled'),
  model_class: z.literal('predictive'),
  /**
   * The integer-0-100 confidence floor this model MUST clear (against the eval harness) before it may be
   * promoted to ENABLED and added to AttributionModelIdSchema. The activation gate, not a runtime score.
   */
  target_confidence_floor: ConfidenceScoreSchema,
  /** Why it is disabled — the human-readable NotImplementedYet reason. */
  not_implemented_reason: z.string().min(1),
});
export type DisabledPredictiveModel = z.infer<typeof DisabledPredictiveModelSchema>;

/**
 * The ENABLED attribution models, keyed by AttributionModelId. The deterministic models
 * (first/last/linear/position_based/time_decay) are per-journey closed-forms; data_driven is the
 * GLOBAL Markov removal-effect model. This is the single
 * registry the engine, serving (channel-roas) and the UI agree on which ids may be selected.
 */
export const ATTRIBUTION_MODEL_REGISTRY: Record<AttributionModelId, EnabledAttributionModel> = {
  first_touch: { id: 'first_touch', status: 'enabled', model_class: 'deterministic', global: false },
  last_touch: { id: 'last_touch', status: 'enabled', model_class: 'deterministic', global: false },
  linear: { id: 'linear', status: 'enabled', model_class: 'deterministic', global: false },
  position_based: { id: 'position_based', status: 'enabled', model_class: 'deterministic', global: false },
  time_decay: { id: 'time_decay', status: 'enabled', model_class: 'deterministic', global: false },
  data_driven: { id: 'data_driven', status: 'enabled', model_class: 'statistical', global: true },
};

/**
 * Registered-DISABLED predictive models. They are NOT in AttributionModelIdSchema (correctly — they are
 * not built), so they can never be selected or served. Listed so they are first-class the moment one is
 * implemented (promotion = build the port + add the id to the enum + flip the registry entry to enabled).
 */
export const DISABLED_PREDICTIVE_MODELS: readonly DisabledPredictiveModel[] = [
  {
    future_id: 'uplift',
    status: 'disabled',
    model_class: 'predictive',
    target_confidence_floor: 70,
    not_implemented_reason: 'NotImplementedYet — causal-uplift attribution model not built (V4 deferred).',
  },
  {
    future_id: 'survival',
    status: 'disabled',
    model_class: 'predictive',
    target_confidence_floor: 70,
    not_implemented_reason: 'NotImplementedYet — time-decay survival attribution model not built (V4 deferred).',
  },
  {
    future_id: 'shapley',
    status: 'disabled',
    model_class: 'predictive',
    target_confidence_floor: 80,
    not_implemented_reason: 'NotImplementedYet — Shapley-value attribution model not built (V4 deferred).',
  },
] as const;

/**
 * Thrown when caller asks for the port of a registered-but-DISABLED strategy. The explicit, loud
 * alternative to silently returning a faked/zeroed weight vector — deferred strategies fail closed.
 */
export class NotImplementedYetError extends Error {
  /** Stable error code for the BFF/observability seam. */
  readonly code = 'NOT_IMPLEMENTED_YET' as const;
  constructor(public readonly feature: string) {
    super(
      `[intelligence] '${feature}' is registered but NOT IMPLEMENTED YET — no faked output (V4 deferred-strategy rule).`,
    );
    this.name = 'NotImplementedYetError';
  }
}

/** True ⇔ `id` is a built, selectable attribution model (a key of ATTRIBUTION_MODEL_REGISTRY). */
export function isAttributionModelEnabled(id: string): id is AttributionModelId {
  return Object.prototype.hasOwnProperty.call(ATTRIBUTION_MODEL_REGISTRY, id);
}

/**
 * Assert a model id is ENABLED before resolving its port. For a registered-disabled predictive id (or any
 * unknown id) this throws NotImplementedYetError rather than fabricating a strategy — the never-faked
 * guarantee. The actual port factory (returning an AttributionModelPort) lives in @brain/metric-engine;
 * this contract only enforces the enabled/disabled boundary.
 */
export function assertAttributionModelEnabled(id: string): AttributionModelId {
  if (isAttributionModelEnabled(id)) return id;
  throw new NotImplementedYetError(`attribution model '${id}'`);
}

// ── 2. Gold data-product descriptor (the TS form of mart_registry.py MartSpec) ─

/**
 * GoldDataProduct — the declarative descriptor of one Iceberg medallion data product, the TS contract
 * form of db/iceberg/spark/parity/mart_registry.py MartSpec. The IntelligenceJob template reads it to
 * know WHAT to (re)build + MERGE on, and the lineage/parity layer reads it to know the product's identity,
 * its money columns and its upstreams.
 *
 * MONEY RULE: `money_columns` NAMES the bigint-minor-unit columns; each one is paired on-row with the
 * `currency_column` (default 'currency_code') — money is per-currency, NEVER blended, NEVER a float.
 * TENANT RULE: `tenant_column` is fixed to 'brand_id' and is the implicit-first column of every `pk`.
 */
export const GoldDataProductSchema = z.object({
  /** Iceberg table name (e.g. 'gold_revenue_ledger') — same on the Spark mart + any dbt-era predecessor. */
  name: z.string().min(1),
  /** Medallion layer → picks the Iceberg catalog/namespace. */
  layer: MedallionLayerSchema,
  /**
   * Product PHASE classifier — routes the mart to the identity spine vs the BI surface:
   *   'identity' — the customer/journey identity products (gold_customer_360, gold_journey,
   *                identity-side snapshots): "who is this person".
   *   'bi'       — business-intelligence marts (attribution, segments, scores, health, cac,
   *                executive, recommendation, retention, …): "what is happening / why".
   * Mirrors GoldMartSpec.phase (db/iceberg/spark/gold/_gold_registry.py). Pure metadata.
   */
  phase: z.enum(['identity', 'bi']),
  /** Iceberg catalog the product lives in (V4: brain_{bronze,silver,gold}_local). */
  iceberg_catalog: z.string().min(1),
  /**
   * PRIMARY KEY columns — the identity the row is keyed by (the MERGE-on-PK set). brand_id is the
   * implicit-first tenant key and MUST be present here as the leading column.
   */
  pk: z.array(z.string().min(1)).min(1),
  /**
   * The bigint-minor-unit money columns (each paired with `currency_column` on-row). Empty for a
   * non-monetary product (row-identity only). NEVER a blended cross-currency sum.
   */
  money_columns: z.array(z.string().min(1)).default([]),
  /** The tenant key column — fixed to brand_id (V4 rule 5). */
  tenant_column: z.literal('brand_id').default('brand_id'),
  /** The sibling ISO-4217 currency column every money column is denominated by. */
  currency_column: z.string().min(1).default('currency_code'),
  /**
   * Upstream products this product is folded from (lineage). Names of the Silver/Gold products read at
   * build time — features + marts are RUNTIME-folded from the Silver spine (no precompute table).
   */
  reads_from: z.array(z.string().min(1)).default([]),
  /**
   * The StarRocks async materialized view (brain_serving.mv_*) the app/BFF reads this product THROUGH.
   * Null ⇔ not yet served. The app NEVER reads the Iceberg product directly (V4 serving rule).
   */
  serving_mv: z.string().min(1).nullable().default(null),
  /** True until the owning phase confirms PK/money against the built Spark job. */
  provisional: z.boolean().default(false),
});
export type GoldDataProduct = z.infer<typeof GoldDataProductSchema>;

/** A set of data-product descriptors (e.g. the products one IntelligenceJob rebuilds). */
export const GoldDataProductsSchema = z.array(GoldDataProductSchema);
export type GoldDataProducts = z.infer<typeof GoldDataProductsSchema>;

// ── 3. The Gold data-product REGISTRY (the declared, served products) ──────────

/**
 * GOLD_DATA_PRODUCT_REGISTRY — the canonical, validated array of the Gold data products that have a
 * built Spark job + a Trino serving view (db/trino/views/mv_*.sql) + a metric-engine read seam. A mart
 * is "done" only once it has a row HERE (the V4 definition-of-done registry entry). This is the TS
 * mirror of db/iceberg/spark/parity/mart_registry.py for the products the intelligence/serving layer
 * binds to — NOT every mart, but the ones with a formal serving contract.
 *
 * Parsed through GoldDataProductsSchema at module load so a malformed entry fails loudly at import.
 */
export const GOLD_DATA_PRODUCT_REGISTRY: GoldDataProducts = GoldDataProductsSchema.parse([
  {
    // CONFIRMED against mart_registry.py MartSpec(gold_customer_360) + db/iceberg/spark/gold/
    // gold_customer_360.py + db/trino/views/mv_gold_customer_360.sql. PK (brand_id, brain_id); the only
    // money column is lifetime_value_minor (bigint minor + sibling currency_code), carried verbatim from
    // the silver_customer spine (the 360 is a denormalized JOIN, not a money computation).
    name: 'gold_customer_360',
    layer: 'gold',
    // identity-phase: the denormalized "who is this person" 360 spine (Phase-1 → Phase-2 handoff).
    phase: 'identity',
    iceberg_catalog: 'brain_gold_local',
    pk: ['brand_id', 'brain_id'],
    money_columns: ['lifetime_value_minor'],
    tenant_column: 'brand_id',
    currency_column: 'currency_code',
    reads_from: ['silver_customer', 'silver_order_state'],
    // V4 serving is a Trino view (db/trino/views/mv_gold_customer_360.sql) — the app reads the product
    // THROUGH this two-part name, never the Iceberg table directly.
    serving_mv: 'brain_serving.mv_gold_customer_360',
    provisional: false,
  },
]);

/** Look up a registered Gold data product by name (undefined ⇔ not a declared/served product). */
export function findGoldDataProduct(name: string): GoldDataProduct | undefined {
  return GOLD_DATA_PRODUCT_REGISTRY.find((p) => p.name === name);
}

// ── 4. The Customer360 CONTRACT (Phase-1 Identity → Phase-2 BI handoff) ────────

/**
 * Deterministic customer-health band — the recency/frequency churn signal, mirroring the
 * db/iceberg/spark/gold/gold_customer_health.py vocabulary (healthy ≤90d, at_risk ≤180d, else churned).
 * The closed set Phase-2 binds to; NEVER a free string at the BI boundary.
 */
export const HealthBandSchema = z.enum(['healthy', 'at_risk', 'churned']);
export type HealthBand = z.infer<typeof HealthBandSchema>;

/**
 * Churn score as an INTEGER 0-100 (0 = no churn risk, 100 = certain churn). It is a RISK score, NOT a
 * confidence and NOT money — kept as its own int seam so it is never blended with the money columns
 * (V4 money/confidence non-blending rule). Mirrors the deterministic churn-risk band of
 * gold_customer_scores (high/medium/low) projected onto a 0-100 scale at the mart boundary.
 */
export const ChurnScoreSchema = z.number().int().min(0).max(100);
export type ChurnScore = z.infer<typeof ChurnScoreSchema>;

/**
 * Customer LIFECYCLE STAGE — the closed deterministic stage folded onto gold_customer_360 from the
 * gold_customer_health band + the lifetime order count (db/iceberg/spark/gold/_customer_360_enrich.py):
 *   new      — healthy (recent) with <= 1 order (just acquired)
 *   active   — healthy (recent) with  > 1 order (engaged repeat customer)
 *   at_risk  — recency past the at-risk threshold (gold_customer_health 'at_risk')
 *   churned  — recency past the churn threshold  (gold_customer_health 'churned')
 * Distinct from `lifecycle_state` (the ORDER terminal-state vocabulary, delivered/rto/…). NEVER a free
 * string at the BI boundary. Null ⇔ no health row yet for this customer (cold refresh cycle).
 */
export const LifecycleStageSchema = z.enum(['new', 'active', 'at_risk', 'churned']);
export type LifecycleStage = z.infer<typeof LifecycleStageSchema>;

/**
 * Customer360Contract — the FORMAL Phase-1 Identity → Phase-2 BI handoff boundary: ONE denormalized row
 * per (brand_id, brain_id) that names EXACTLY the fields Phase-2/BI consumes off gold_customer_360.
 * Phase-2 binds to THIS contract and NEVER re-derives identity (brand_id/brain_id are the resolved
 * Phase-1 identity keys, taken as given) nor re-computes money/lifecycle/health — it reads them here.
 *
 * This is distinct from the identity control-plane `Customer360` (identity.api.v1 — the merge/identifier
 * admin view): that is the identity-graph projection; THIS is the BI data-product row.
 *
 * INVARIANTS:
 *  - PII HASH-ONLY: brain_id + brand_id only — NEVER a raw email/phone (V4 PII rule).
 *  - MONEY: lifetime_value_minor / aov_minor are bigint-minor-unit STRINGS (MinorUnits, never a float),
 *    both denominated by the SINGLE sibling currency_code — per-currency, never blended.
 *  - confidence/churn are integers, never blended with money (churn_score is its own int 0-100 seam).
 *  - brand_id is the implicit-first tenant key.
 */
export const Customer360ContractSchema = z.object({
  /** Tenant key — implicit-first column (V4 rule 5). */
  brand_id: z.string().min(1),
  /** The resolved Phase-1 identity key (Neo4j SoR, ADR-0004). Phase-2 takes this as given. */
  brain_id: z.string().min(1),
  /** Lifetime realized value in bigint MINOR units (string) — denominated by currency_code, never blended. */
  lifetime_value_minor: MinorUnitsSchema,
  /** Average order value in bigint MINOR units (string) — same currency_code as lifetime_value_minor. */
  aov_minor: MinorUnitsSchema,
  /** The single ISO-4217 currency both money columns are denominated by (the sibling currency seam). */
  currency_code: z.string().min(1),
  /** Lifetime order count (non-monetary cardinal). */
  lifetime_orders: z.number().int().nonnegative(),
  /** Current deterministic lifecycle state — reuses the closed LifecycleState set. */
  lifecycle_state: LifecycleStateSchema,
  /** Deterministic recency/frequency health band (the churn signal). */
  health_band: HealthBandSchema,
  /** Churn-risk score as an INTEGER 0-100 — NOT money, NOT confidence. */
  churn_score: ChurnScoreSchema,
  /** RFM/value segment label this customer belongs to (gold_customer_segments grain). */
  segment: z.string().min(1),
  /** First-touch acquisition source/channel (deterministic journey attribution of first identification). */
  acquisition_source: z.string().min(1),
  /** ISO-8601 timestamp of last observed activity (last_seen). Null ⇔ never observed post-identification. */
  last_activity: z.string().min(1).nullable(),
  // ── B2 enrichment fields (folded onto gold_customer_360; nullable = no source signal) ──────────
  /** ISO-8601 timestamp of the most recent observed activity (max touchpoint, else last_seen). */
  last_activity_at: z.string().min(1).nullable(),
  /** Deterministic MODE of the customer's journey channel (silver_touchpoint). Null ⇔ no journey. */
  preferred_channel: z.string().min(1).nullable(),
  /** Deterministic MODE of the customer's device class (silver_page_view via the journey bridge). */
  preferred_device: z.string().min(1).nullable(),
  /** Deterministic MODE of the customer's purchased product category (silver_order_line). */
  top_category: z.string().min(1).nullable(),
  /** Customer lifecycle stage — closed set, folded from health_band + order count. Null ⇔ no health row. */
  lifecycle_stage: LifecycleStageSchema.nullable(),
});
export type Customer360Contract = z.infer<typeof Customer360ContractSchema>;
