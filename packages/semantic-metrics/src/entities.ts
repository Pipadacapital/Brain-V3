// SPEC:D.2
/**
 * @brain/semantic-metrics — the ENTITY resolution table.
 *
 * Maps each Wave-D.1 semantic ENTITY to its physical Iceberg serving object and records the two
 * facts the compiler needs to compile a metric onto it SAFELY:
 *
 *  1. `table` — the physical Trino object the metric×grain view reads FROM (the D.1 semantic_* views
 *     under iceberg.brain_serving; see db/trino/views/semantic_*.sql).
 *
 *  2. How this entity satisfies the §1.4 attribution-truth invariant for a `deterministic_only`
 *     metric — the compiler must be able to PROVE probabilistic-identity rows are excluded:
 *       • `identityBasisColumn` — a PHYSICAL `identity_basis` column present on the entity; the
 *         compiler injects `AND identity_basis = 'deterministic'`. (semantic_customer / semantic_journey.)
 *       • `deterministicByConstruction` — the entity is built ONLY from the deterministic spine
 *         (§1.4: probabilistic links are physically segregated and never reach order/revenue/spend
 *         facts), so it carries NO basis column and NO predicate is needed — but the guarantee is
 *         recorded here so the D2.deterministic test can assert it. (semantic_order/product/campaign.)
 *     A `deterministic_only` metric on an entity that is NEITHER → the compiler FAILS CLOSED
 *     (it cannot prove the exclusion, so it refuses to emit SQL).
 *
 * Tenancy (AMD-07 D3): Trino REST has NO row policy. Every compiled view embeds the literal
 * `${BRAND_PREDICATE}` sentinel (BRAND_PREDICATE below) in its WHERE — the serving seam
 * (withTrinoBrand) replaces it with `brand_id = ?`. The predicate is BAKED IN by the compiler
 * (compile-time), never added ad-hoc by a caller.
 *
 * @see knowledge-base/PLAN-OF-RECORD.md §D.1 (entities) · §D.2 (registry) · §1.4 (attribution truth)
 * @see knowledge-base/amendments/AMD-07-identity-map-bitemporality.md (D3 tenancy = ${BRAND_PREDICATE})
 * @see knowledge-base/amendments/AMD-25-cross-entity-blended-metrics.md (cross-entity `all`-grain blend)
 */

import type { SemanticEntity } from './schema.js';

/**
 * The compile-time tenancy sentinel — identical to @brain/metric-engine's BRAND_PREDICATE token.
 * Re-declared as a bare string constant (NOT imported) so this compiler package stays free of any
 * infrastructure/serving dependency (hexagonal). The serving seam substitutes `brand_id = ?`.
 */
export const BRAND_PREDICATE = '${BRAND_PREDICATE}';

/** The physical resolution + §1.4 basis metadata for one semantic entity. */
export interface EntityBinding {
  /** The physical Trino serving object the compiled view reads FROM. */
  readonly table: string;
  /** A PHYSICAL identity_basis column, or null when basis is guaranteed by construction. */
  readonly identityBasisColumn: 'identity_basis' | null;
  /** True when the entity is built ONLY from the deterministic spine (§1.4) → no basis predicate needed. */
  readonly deterministicByConstruction: boolean;
  /** Whether this entity carries a per-currency money axis (a `currency_code` column exists). */
  readonly hasCurrency: boolean;
  /** One-line provenance note surfaced in the catalog + gate evidence. */
  readonly note: string;
}

export const ENTITY_BINDINGS: Record<SemanticEntity, EntityBinding> = {
  semantic_customer: {
    table: 'iceberg.brain_serving.semantic_customer',
    identityBasisColumn: 'identity_basis',
    deterministicByConstruction: true,
    hasCurrency: true,
    note: 'gold_customer_360 spine (deterministic) + identity_current_v summary + RFM scores.',
  },
  semantic_order: {
    table: 'iceberg.brain_serving.semantic_order',
    identityBasisColumn: null,
    deterministicByConstruction: true,
    hasCurrency: true,
    note: 'silver_order_state ⋈ gold_order_economics — deterministic order spine (§1.4); no probabilistic rows reach it.',
  },
  semantic_product: {
    table: 'iceberg.brain_serving.semantic_product',
    identityBasisColumn: null,
    deterministicByConstruction: true,
    hasCurrency: true,
    note: 'gold_product_detail + gold_product_economics — catalog/performance facts (no identity axis).',
  },
  semantic_campaign: {
    table: 'iceberg.brain_serving.semantic_campaign',
    identityBasisColumn: null,
    deterministicByConstruction: true,
    hasCurrency: true,
    note: 'gold_campaign_performance ⋈ gold_campaign_attribution — deterministic attribution ledger only (§1.4). No time axis (AMD-25).',
  },
  semantic_journey: {
    table: 'iceberg.brain_serving.semantic_journey',
    identityBasisColumn: 'identity_basis',
    deterministicByConstruction: true,
    hasCurrency: true,
    note: 'journey_events canonical ledger — carries a physical identity_basis (deterministic canonical; probabilistic overlays are a separate view).',
  },
};

/** Resolve an entity → its binding, or throw (fail-closed) on an unknown entity. */
export function resolveEntity(entity: SemanticEntity): EntityBinding {
  const b = ENTITY_BINDINGS[entity];
  if (!b) throw new Error(`[semantic-metrics] no physical binding for entity '${entity}'`);
  return b;
}
