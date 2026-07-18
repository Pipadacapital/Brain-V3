/**
 * ScopedRecompute — domain type + pure affected-set mapper for the identity-change
 * → scoped-Gold-recompute → cache-invalidation pipeline.
 *
 * PURE MODULE: no IO, no Kafka, no SQL. Takes a typed identity-change event (the
 * consumer parses the raw Kafka message into this shape) and returns a ScopedRecompute.
 * Same event → same output (deterministic). Tests for this module are fast +
 * have zero infrastructure dependencies.
 *
 * ALGORITHM (deterministic, per identity-change event type):
 *   identity.merged     → affected_brain_ids = sort([canonical_brain_id, merged_brain_id])
 *   identity.suppressed → affected_brain_ids = [brain_id]
 *   identity.erased     → SEAM: not yet a live event (no erased contract in
 *                          packages/contracts/src/events/identity.events.v1.ts v1);
 *                          wire this arm when identity.erased.v1 is added to contracts.
 *                          Structurally identical to suppressed (single brain_id subject).
 *
 * The affected_marts set is ALWAYS the full CUSTOMER_GRAINED_MARTS. A per-brain_id
 * identity change (merge or suppression) can cascade into any customer-grained Gold mart
 * read by the serving layer — we do not attempt to narrow further (safe default).
 *
 * DETERMINISM INVARIANTS:
 *  - Same event_id → same request_id (keyed on brand_id + source_event_id).
 *  - A merge of A + B produces exactly {A, B} in affected_brain_ids, never a third id.
 *  - A suppression of X produces exactly {X} in affected_brain_ids.
 *  - brand_id in output = brand_id in input — no cross-brand leakage.
 *  - affected_marts = CUSTOMER_GRAINED_MARTS (read-only const, never mutated).
 */
import { createHash } from 'node:crypto';

// ── Customer-grained marts (sourced from db/iceberg/spark/gold/_gold_registry.py + task spec)
// These are the Gold marts whose rows are keyed on (brand_id, brain_id) or whose lineage
// reads the brain_id spine (attribution paths/credits, journey). A per-brain_id identity
// change (merge or suppression) stalks any of these in the StarRocks brain_serving MVs.
//
// NOTE: kept in sync with _gold_registry.py customer-grained entries. If a new customer-
// grained mart is added to the registry, add its name here too.
export const CUSTOMER_GRAINED_MARTS = [
  'gold_customer_360',
  'gold_customer_scores',
  'gold_customer_segments',
  'gold_cohorts',
  'gold_customer_health',
  'gold_journey',
  'gold_recommendation_features',
  'gold_ai_features',
  'gold_attribution_credit',
  'gold_attribution_paths',
  'gold_marketing_attribution',
] as const;

export type CustomerGrainedMart = (typeof CUSTOMER_GRAINED_MARTS)[number];

/** StarRocks serving MV name for each customer-grained mart (from _gold_registry.py mv_name). */
export const MART_TO_MV: Readonly<Record<CustomerGrainedMart, string>> = {
  gold_customer_360:             'brain_serving.mv_gold_customer_360',
  gold_customer_scores:          'brain_serving.mv_gold_customer_scores',
  gold_customer_segments:        'brain_serving.mv_gold_customer_segments',
  gold_cohorts:                  'brain_serving.mv_gold_cohorts',
  gold_customer_health:          'brain_serving.mv_gold_customer_health',
  gold_journey:                  'brain_serving.mv_gold_journey',
  gold_recommendation_features:  'brain_serving.mv_gold_recommendation_features',
  gold_ai_features:              'brain_serving.mv_gold_ai_features',
  gold_attribution_credit:       'brain_serving.mv_gold_attribution_credit',
  gold_attribution_paths:        'brain_serving.mv_gold_attribution_paths',
  gold_marketing_attribution:    'brain_serving.mv_gold_marketing_attribution',
};

/**
 * The narrow view of an identity-change event that this module consumes. The consumer
 * parses the raw Kafka Buffer using full Zod contract schemas, then extracts this minimal
 * shape so the mapper stays pure and zero-dependency.
 *
 * identity.erased is a SEAM: not yet in packages/contracts/src/events/identity.events.v1.ts.
 * It is included here so the type system + the mapper switch case are wired and ready. Wire
 * the consumer arm when identity.erased.v1 is added to contracts. Do NOT fake output.
 */
export type IdentityChangeInput =
  | {
      event_name: 'identity.merged';
      event_id: string;
      brand_id: string;
      payload: { canonical_brain_id: string; merged_brain_id: string };
    }
  | {
      event_name: 'identity.suppressed';
      event_id: string;
      brand_id: string;
      payload: { brain_id: string };
    }
  | {
      // SEAM: not yet a live event type — wire consumer arm when identity.erased.v1 lands.
      event_name: 'identity.erased';
      event_id: string;
      brand_id: string;
      payload: { brain_id: string };
    };

/** A resolved scoped-recompute request: which brand, which brain_ids, which marts to bust. */
export interface ScopedRecompute {
  /** Tenant key — all affected rows in this request are brand-scoped (I-S01). */
  brand_id: string;
  /**
   * Deterministic idempotency key:
   * deterministicUuid(`${brand_id}||scoped-recompute||${source_event_id}`).
   * Same Kafka message redelivered → same request_id → ops upsert is a no-op.
   */
  request_id: string;
  /** The identity event_id that triggered this request (causation chain + audit). */
  source_event_id: string;
  /** e.g. 'identity.merged' | 'identity.suppressed'. */
  trigger_event: string;
  /** Sorted, deduplicated brain_ids whose Gold rows are now stale. */
  affected_brain_ids: string[];
  /**
   * CUSTOMER_GRAINED_MARTS — the full set of customer-keyed Gold marts.
   * Read-only reference; never sliced or mutated.
   */
  affected_marts: typeof CUSTOMER_GRAINED_MARTS;
  /** brain_serving.mv_* names corresponding to each mart in affected_marts. */
  affected_mvs: string[];
  /** ISO-8601 UTC instant the consumer generated this request. */
  requested_at: string;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

/**
 * Deterministic UUID (v5-like, SHA-256-based) — same scheme as
 * IdentityEventPublisher.deterministicUuid in the identity domain. Pure: no IO,
 * no randomness. Same input always → same UUID.
 */
function deterministicUuid(input: string): string {
  const hex = createHash('sha256').update(input, 'utf8').digest('hex');
  const h = hex.slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '5' + h.slice(13, 16),
    ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

/** Deduplicate and sort brain_ids for a canonical, deterministic affected set. */
function sortedUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Map an identity-change event to a ScopedRecompute.
 *
 * DETERMINISM: same (brand_id, event_id) → same (request_id, affected_brain_ids, affected_marts).
 * No randomness, no IO, no mutable state.
 *
 * CORRECTNESS:
 *   merged: exactly {canonical_brain_id, merged_brain_id} — never a third id.
 *   suppressed: exactly {brain_id} — the single suppressed subject.
 *   erased (SEAM): identical to suppressed; wire consumer arm when contract lands.
 */
export function mapIdentityEventToScopedRecompute(
  event: IdentityChangeInput,
  now: string,
): ScopedRecompute {
  let affected_brain_ids: string[];

  switch (event.event_name) {
    case 'identity.merged': {
      // A merge of A→B affects BOTH ids: the canonical survivor (A) has rows that absorb
      // B's history, and the merged-away (B) has rows that are now stale / must be removed.
      affected_brain_ids = sortedUnique([
        event.payload.canonical_brain_id,
        event.payload.merged_brain_id,
      ]);
      break;
    }
    case 'identity.suppressed': {
      // A suppression targets one identity — only its rows in the customer-grained marts
      // are stale (they should be suppressed / omitted from serving).
      affected_brain_ids = [event.payload.brain_id];
      break;
    }
    case 'identity.erased': {
      // SEAM: identity.erased — structurally identical to suppressed (single subject).
      // Wire the consumer arm when identity.erased.v1 is added to contracts.
      affected_brain_ids = [event.payload.brain_id];
      break;
    }
    // No default needed: TypeScript exhaustive check — if a new arm is added to
    // IdentityChangeInput without a case here, the compiler reports an error.
  }

  const affected_mvs = CUSTOMER_GRAINED_MARTS.map((m) => MART_TO_MV[m]);

  return {
    brand_id:           event.brand_id,
    request_id:         deterministicUuid(`${event.brand_id}||scoped-recompute||${event.event_id}`),
    source_event_id:    event.event_id,
    trigger_event:      event.event_name,
    affected_brain_ids,
    affected_marts:     CUSTOMER_GRAINED_MARTS,
    affected_mvs,
    requested_at:       now,
  };
}

// ── Repository port (ADR-0015 WS3) ─────────────────────────────────────────────
// Moved here from the removed IdentityChangeRecomputeConsumer: identity now resolves in the Silver
// transform stage (jobs/silver-identity), which writes ScopedRecompute requests DIRECTLY instead of
// publishing identity.* events for a streaming consumer to fold. Type-only — still a pure module.

/** Port for persisting ScopedRecompute requests to ops.scoped_recompute_request.
 *  Concrete implementation: PgScopedRecomputeRepository (infrastructure/pg/). */
export interface IScopedRecomputeRepository {
  upsert(recompute: ScopedRecompute): Promise<void>;
}
