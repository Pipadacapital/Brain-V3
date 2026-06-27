/**
 * cache.invalidate.v1 — the cache-invalidation events on the doc-07 widened envelope.
 *
 * Two events, both on EventEnvelopeBaseSchema (the tenant-scoped envelope: schema_version, event_id,
 * brand_id, correlation_id, event_name, occurred_at):
 *   - gold.rewritten.v1   — emitted by a Spark/IntelligenceJob when a Gold (or Silver snap_*) data product
 *                           is rewritten (a new Iceberg snapshot). The PRODUCER signal.
 *   - cache.invalidate.v1 — the explicit cache-bust command the Analytics Gateway acts on to evict the
 *                           affected Redis entries (cache-aside, invalidate-on-write).
 *
 * FLOW: Spark rewrites brain_gold.<product> → emits gold.rewritten.v1 → the Analytics Gateway consumes it,
 * maps the rewritten product + affected scope to its Redis key set, and busts them (or emits an explicit
 * cache.invalidate.v1 for a downstream cache tier). Stale serving caches are evicted on write, not by TTL.
 *
 * INVARIANTS:
 *  - brand_id REQUIRED on the envelope — the tenant key (I-S01). Every cache key these events name is
 *    brand-scoped (the caller MUST include brand_id in the Redis key — tenant-scoped keys, no cross-tenant
 *    bust). A cross-tenant invalidation is a P0 isolation breach.
 *  - NO PII (I-S02): payloads carry only data-product NAMES + cache keys/prefixes/snapshot ids. Never an
 *    email/phone/customer id. Cache keys are opaque, brand-scoped strings.
 *  - schema_version = additive evolution only (I-E02 FULL_TRANSITIVE).
 *  - NO money in these events (they name products, they don't carry values) — so there is no float here.
 */
import { z } from 'zod';

import { EventEnvelopeBaseSchema } from './m1.events.v1.js';
import { MedallionLayerSchema } from '../api/intelligence.api.v1.js';

// ── Affected cache scope (shared by both events) ──────────────────────────────

/**
 * The slice of cache to evict for the named product, within ONE brand. All three are tenant-scoped: the
 * Analytics Gateway prefixes/derives every key with the envelope brand_id before touching Redis.
 *   - `all: true`     → evict everything cached for this product+brand (the safe default for a full rewrite).
 *   - `keys`          → exact, fully-qualified (already brand-scoped) Redis keys to delete.
 *   - `key_prefixes`  → logical key prefixes / tags to scan-and-evict (e.g. a metric id or dashboard id).
 * Honest empty: `{ all: true, keys: [], key_prefixes: [] }` ⇔ "bust the whole product for this brand".
 */
export const CacheScopeSchema = z.object({
  /** Evict the entire cached surface of the product for this brand. */
  all: z.boolean().default(false),
  /** Exact brand-scoped Redis keys to delete. */
  keys: z.array(z.string().min(1)).default([]),
  /** Logical key prefixes / tags to scan-and-evict (brand-scoped). */
  key_prefixes: z.array(z.string().min(1)).default([]),
});
export type CacheScope = z.infer<typeof CacheScopeSchema>;

// ── 1. gold.rewritten.v1 (producer signal) ────────────────────────────────────

export const GoldRewrittenPayloadSchema = z.object({
  /** The data-product (Iceberg mart) name that was rewritten — see GoldDataProduct.name. */
  gold_product: z.string().min(1),
  /** The medallion layer of the rewritten product (gold, or silver for snap_* products). */
  layer: MedallionLayerSchema,
  /** The Iceberg snapshot id produced by this rewrite (for lineage/audit). Null if unavailable. */
  snapshot_id: z.string().min(1).nullable().default(null),
  /** Rows written/merged this rewrite (observability — counts only, no money, no PII). */
  rows_written: z.number().int().nonnegative().nullable().default(null),
  /** Which slice changed → what the gateway should bust. Default `all` = whole product for the brand. */
  affected_scope: CacheScopeSchema,
});

export const GoldRewrittenEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('gold.rewritten'),
  payload: GoldRewrittenPayloadSchema,
});
export type GoldRewrittenEvent = z.infer<typeof GoldRewrittenEventSchema>;

export const GOLD_REWRITTEN_V1_TOPIC_SUFFIX = 'intelligence.gold.rewritten.v1' as const;
export const GOLD_REWRITTEN_V1_EVENT_NAME = 'gold.rewritten' as const;
export const GOLD_REWRITTEN_V1_AVRO_SUBJECT = 'brain.intelligence.gold.rewritten.v1' as const;

// ── 2. cache.invalidate.v1 (explicit bust command) ────────────────────────────

/** Why the cache is being busted — drives the gateway's eviction policy + audit reason. */
export const CacheInvalidateReasonSchema = z.enum([
  'gold_rewritten', // a Gold product was rewritten (the common path)
  'schema_change', // a product's schema/partition evolved
  'manual', // an operator-triggered bust
  'backfill', // a replay/backfill changed historical rows
]);
export type CacheInvalidateReason = z.infer<typeof CacheInvalidateReasonSchema>;

export const CacheInvalidatePayloadSchema = z.object({
  /** The data-product whose serving cache is to be evicted — see GoldDataProduct.name. */
  gold_product: z.string().min(1),
  /** The brand-scoped slice of cache to evict. */
  scope: CacheScopeSchema,
  /** Why — defaults to the gold-rewritten path. */
  reason: CacheInvalidateReasonSchema.default('gold_rewritten'),
});

export const CacheInvalidateEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('cache.invalidate'),
  payload: CacheInvalidatePayloadSchema,
});
export type CacheInvalidateEvent = z.infer<typeof CacheInvalidateEventSchema>;

export const CACHE_INVALIDATE_V1_TOPIC_SUFFIX = 'intelligence.cache.invalidate.v1' as const;
export const CACHE_INVALIDATE_V1_EVENT_NAME = 'cache.invalidate' as const;
export const CACHE_INVALIDATE_V1_AVRO_SUBJECT = 'brain.intelligence.cache.invalidate.v1' as const;

// ── Schema registry (for codegen, mirrors M1_EVENT_SCHEMAS) ───────────────────

export const CACHE_EVENT_SCHEMAS = {
  'gold.rewritten': GoldRewrittenEventSchema,
  'cache.invalidate': CacheInvalidateEventSchema,
} as const;
