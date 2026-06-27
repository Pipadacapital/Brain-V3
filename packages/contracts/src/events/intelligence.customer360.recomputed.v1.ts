/**
 * intelligence.customer360.recomputed.v1 — the OPTIONAL receipt event emitted when a brand's
 * gold_customer_360 row is rebuilt for ONE brain_id (the Phase-1 Identity → Phase-2 BI handoff is
 * re-materialized). It mirrors the cache.invalidate.v1 shape: a thin, money-free, PII-free product +
 * scope receipt on the doc-07 widened envelope (EventEnvelopeBaseSchema).
 *
 * FLOW: an IntelligenceJob / Spark rebuild rewrites a customer's gold_customer_360 row → emits
 * intelligence.customer360.recomputed.v1 (the RECEIPT — "this brain_id's 360 is fresh as of snapshot X")
 * → downstream caches / BI binders evict + rebind the affected brand-scoped Customer360 entry. It is the
 * subject-scoped sibling of gold.rewritten.v1 (which signals a whole-product rewrite): this one names the
 * single brain_id whose 360 changed, so a consumer can bust ONE customer's cache, not the whole product.
 *
 * It is OPTIONAL: the medallion is correct without anyone emitting or consuming it (cache.invalidate.v1
 * at product grain remains the floor). It exists so a per-subject recompute can be observed + cache-busted
 * precisely when a job chooses to emit it.
 *
 * INVARIANTS (mirror cache.invalidate.v1):
 *  - brand_id REQUIRED on the envelope — the tenant key (I-S01). The brain_id in the payload is the
 *    Phase-1 identity key; every cache key derived from it is brand-scoped. A cross-tenant bust is P0.
 *  - NO PII (I-S02): brain_id + product NAME + opaque brand-scoped cache scope only. NEVER an email/phone.
 *  - NO money in this event (it is a receipt, it carries no values) — so there is no float here.
 *  - schema_version = additive evolution only (I-E02 FULL_TRANSITIVE).
 */
import { z } from 'zod';

import { EventEnvelopeBaseSchema } from './m1.events.v1.js';
import { CacheScopeSchema } from './cache.invalidate.v1.js';

// ── Why a Customer360 row was recomputed (drives the consumer's rebind/audit) ──

export const Customer360RecomputeReasonSchema = z.enum([
  'identity_merge', // a Phase-1 merge/unmerge changed which events roll into this brain_id
  'order_state_change', // a new/updated order changed lifecycle + lifetime value
  'scheduled_refresh', // the periodic medallion refresh re-materialized the row
  'backfill', // a replay/backfill changed historical rows
  'manual', // an operator-triggered recompute
]);
export type Customer360RecomputeReason = z.infer<typeof Customer360RecomputeReasonSchema>;

export const Customer360RecomputedPayloadSchema = z.object({
  /** The identity key whose 360 was rebuilt — the Phase-1 brain_id (Neo4j SoR, ADR-0004). NOT raw PII. */
  brain_id: z.string().min(1),
  /** The Gold data product rebuilt — see GoldDataProduct.name. Defaults to the only 360 product. */
  gold_product: z.string().min(1).default('gold_customer_360'),
  /** Why the row was recomputed — defaults to the periodic refresh path. */
  reason: Customer360RecomputeReasonSchema.default('scheduled_refresh'),
  /** The Iceberg snapshot id this recompute produced (lineage/audit). Null if unavailable. */
  snapshot_id: z.string().min(1).nullable().default(null),
  /**
   * The brand-scoped slice of serving cache to evict for this subject. Default `all` = bust the whole
   * Customer360 surface for this brand; a precise emitter sets keys/prefixes scoped to the brain_id.
   */
  scope: CacheScopeSchema,
});

export const Customer360RecomputedEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('intelligence.customer360.recomputed'),
  payload: Customer360RecomputedPayloadSchema,
});
export type Customer360RecomputedEvent = z.infer<typeof Customer360RecomputedEventSchema>;

export const CUSTOMER360_RECOMPUTED_V1_TOPIC_SUFFIX =
  'intelligence.customer360.recomputed.v1' as const;
export const CUSTOMER360_RECOMPUTED_V1_EVENT_NAME = 'intelligence.customer360.recomputed' as const;
export const CUSTOMER360_RECOMPUTED_V1_AVRO_SUBJECT =
  'brain.intelligence.customer360.recomputed.v1' as const;

// ── Schema registry (for codegen, mirrors CACHE_EVENT_SCHEMAS) ────────────────

export const CUSTOMER360_EVENT_SCHEMAS = {
  'intelligence.customer360.recomputed': Customer360RecomputedEventSchema,
} as const;
