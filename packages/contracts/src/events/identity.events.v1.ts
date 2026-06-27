/**
 * identity.events.v1 — Zod schemas for the 5 identity-resolution domain events,
 * built on the doc-07 15-field envelope (EventEnvelopeBaseSchema, m1.events.v1.ts).
 *
 *   identity.minted        a brand-new brain_id is created (first sighting of an identity)
 *   identity.linked        an identifier edge is attached to an EXISTING brain_id
 *   identity.merged        two brain_ids are merged into one canonical brain_id
 *   identity.suppressed    a brain_id/identifier is suppressed (consent withdrawn / tombstone / erasure)
 *   identity.review_queued a probable merge is queued for human review (not auto-committed)
 *
 * Topics: {env}.identity.{event}.v1   (e.g. prod.identity.merged.v1)
 * Partition key: brand_id  (tenant-first — every payload is brand_id-scoped; the producer
 *   MUST set the envelope `partition_key` field to brand_id for the identity lane).
 * Idempotency key: (brand_id, event_id).
 *
 * INVARIANTS:
 *  - brand_id REQUIRED on every event (I-S01); these events are tenant(brand_id)-scoped.
 *  - PII discipline (I-S02): payloads carry ONLY salted-hash identifiers, brain_id /
 *    merge_id / review_id, identifier TYPE, tier, rule_version and a ConfidenceVerdict.
 *    NEVER a raw email/phone/name/address — not even an un-hashed identifier value.
 *  - confidence is an INTEGER 0-100 (ConfidenceVerdict.score) — NEVER a float, NEVER 0..1.
 *  - Additive evolution only (I-E02 FULL_TRANSITIVE).
 *  - No probabilistic resolution STRATEGY is implemented or faked in this contract: the
 *    schema carries the resolver's verdict band only; the resolver owns the decision. A
 *    deferred ('probabilistic') verdict band is declared but is produced by no faked path here.
 *
 * Reconciliation with the repo (identity.api.v1.ts read DTOs — repo wins on field names):
 *  - merged event mirrors Customer360MergeSchema (canonical_brain_id, merged_brain_id,
 *    rule_version, identifier_combo).
 *  - review_queued mirrors MergeReviewSchema (review_id, brain_id_a, brain_id_b, trigger_reason).
 *  - identifier_type / tier are `z.string()` to mirror the read DTOs (Customer360Identifier),
 *    not narrowed to an enum (resolver may add tiers without a contract break).
 *  - NOTE: the read DTO surfaces `identifier_hash_prefix` (12 hex, UI-safe). These WIRE events
 *    carry the FULL salted hash (64 hex) because downstream resolution/Silver joins on it; a
 *    hash is not raw PII (I-S02). The 12-hex prefix is a presentation-layer truncation only.
 */
import { z } from 'zod';

import { EventEnvelopeBaseSchema } from './m1.events.v1.js';
// The canonical ConfidenceVerdict lives in the identity domain contracts (richer: score + band +
// reasons + matcher_id + rule_version + identifier_combo). The wire events carry that full verdict so
// downstream has the evidence — re-use it here rather than redefining a thinner duplicate.
import { ConfidenceVerdictSchema } from '../identity/confidence-verdict.js';

// ── ConfidenceVerdict — the resolver's decision, confidence as an INTEGER 0-100 ──

/**
 * Deterministic verdict band derived from the confidence score vs the rule thresholds.
 *  - 'deterministic' : exact salted-hash identifier match (score = 100).
 *  - 'high'          : probabilistic auto-accept above the high threshold.
 *  - 'review'        : in the human-review band → emits identity.review_queued, not a merge.
 *  - 'reject'        : below the floor; no link/merge.
 *  - 'probabilistic' : DEFERRED band reserved for a data-driven scorer that is NOT YET enabled;
 *                       no path in this cluster emits it (declared, never faked).
 */
export const ConfidenceVerdictBandSchema = z.enum([
  'deterministic',
  'high',
  'review',
  'reject',
  'probabilistic',
]);
export type ConfidenceVerdictBand = z.infer<typeof ConfidenceVerdictBandSchema>;

// ConfidenceVerdict (object) is imported from ../identity/confidence-verdict.js (canonical) — see top.
// ConfidenceVerdictBandSchema above stays the wire band enum for the identity event lane.

// ── Shared payload primitives (hash-only — never raw PII, I-S02) ──────────────

/**
 * A salted-hash identifier reference: sha256(per-brand-salt || normalized_value), 64 hex.
 * NEVER the raw email/phone/value. `identifier_type` / `tier` mirror the read DTO as strings.
 */
const HashedIdentifierFields = {
  /** Identifier kind, e.g. 'email' | 'phone' | 'anonymous_id' | 'storefront_customer_id' | 'device'. */
  identifier_type: z.string().min(1),
  /** Resolver tier, e.g. 'strong' | 'weak' | 'strong_on_link' (mirrors Customer360Identifier.tier). */
  tier: z.string().min(1),
  /** Full salted hash (64 hex) — sha256(brand-salt || normalized). NEVER raw PII (I-S02). */
  identifier_hash: z.string().regex(/^[0-9a-f]{64}$/, 'identifier_hash must be 64 lowercase hex chars'),
} as const;

// ── 1. identity.minted ───────────────────────────────────────────────────────
// Emitted: a brand-new brain_id is created on first sighting of an identifier.

export const IdentityMintedPayloadSchema = z.object({
  /** Tenant key — every identity payload is brand_id-scoped (I-S01). */
  brand_id: z.string().uuid(),
  /** The newly minted canonical identity id. */
  brain_id: z.string().uuid(),
  /** The anonymous/device id the brain_id was seeded from, if any. */
  anonymous_id: z.string().nullable().optional(),
  ...HashedIdentifierFields,
  /** Resolution rule-set version that minted this identity (audit/replay). */
  rule_version: z.string().min(1),
  /** Confidence + band for the mint (deterministic first-seen → score 100). */
  verdict: ConfidenceVerdictSchema,
});
export type IdentityMintedPayload = z.infer<typeof IdentityMintedPayloadSchema>;

export const IdentityMintedEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('identity.minted'),
  payload: IdentityMintedPayloadSchema,
});
export type IdentityMintedEvent = z.infer<typeof IdentityMintedEventSchema>;

// ── 2. identity.linked ───────────────────────────────────────────────────────
// Emitted: an identifier edge is attached to an EXISTING brain_id (no new identity).

export const IdentityLinkedPayloadSchema = z.object({
  brand_id: z.string().uuid(),
  /** The existing identity the identifier was linked to. */
  brain_id: z.string().uuid(),
  ...HashedIdentifierFields,
  rule_version: z.string().min(1),
  /** Confidence + band for the link decision. */
  verdict: ConfidenceVerdictSchema,
});
export type IdentityLinkedPayload = z.infer<typeof IdentityLinkedPayloadSchema>;

export const IdentityLinkedEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('identity.linked'),
  payload: IdentityLinkedPayloadSchema,
});
export type IdentityLinkedEvent = z.infer<typeof IdentityLinkedEventSchema>;

// ── 3. identity.merged ───────────────────────────────────────────────────────
// Emitted: two brain_ids are merged into one canonical id (mirrors Customer360Merge).

export const IdentityMergedPayloadSchema = z.object({
  brand_id: z.string().uuid(),
  /** Stable id for THIS merge decision (audit / unmerge handle). */
  merge_id: z.string().uuid(),
  /** The surviving canonical identity. */
  canonical_brain_id: z.string().uuid(),
  /** The identity that was merged INTO the canonical one. */
  merged_brain_id: z.string().uuid(),
  /**
   * The identifier TYPES (or salted-hash refs) whose match triggered the merge —
   * mirrors Customer360Merge.identifier_combo. Hash-only / type-only, never raw PII.
   */
  identifier_combo: z.array(z.string().min(1)),
  rule_version: z.string().min(1),
  /** Confidence + band for the merge (review-band matches go to review_queued instead). */
  verdict: ConfidenceVerdictSchema,
});
export type IdentityMergedPayload = z.infer<typeof IdentityMergedPayloadSchema>;

export const IdentityMergedEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('identity.merged'),
  payload: IdentityMergedPayloadSchema,
});
export type IdentityMergedEvent = z.infer<typeof IdentityMergedEventSchema>;

// ── 4. identity.suppressed ───────────────────────────────────────────────────
// Emitted: a brain_id/identifier is suppressed (consent withdrawn / tombstone / DPDP erasure).

/** Why the identity/identifier is suppressed (fail-closed compliance outcome). */
export const IdentitySuppressionReasonSchema = z.enum([
  'consent_withdrawn',
  'tombstoned',
  'erasure',
  'no_consent',
]);
export type IdentitySuppressionReason = z.infer<typeof IdentitySuppressionReasonSchema>;

export const IdentitySuppressedPayloadSchema = z.object({
  brand_id: z.string().uuid(),
  /** The identity being suppressed. */
  brain_id: z.string().uuid(),
  /**
   * Salted-hash of the suppressed subject (sha256(brand-salt || normalized)), if the
   * suppression is identifier-scoped rather than whole-identity. NEVER raw PII (I-S02).
   */
  subject_hash: z.string().regex(/^[0-9a-f]{64}$/, 'subject_hash must be 64 lowercase hex chars').nullable().optional(),
  /** The compliance reason for suppression. */
  reason: IdentitySuppressionReasonSchema,
  /**
   * The DPDP consent categories suppressed (mirrors consent/suppression CONSENT_CATEGORIES),
   * e.g. ['marketing','advertising']. Empty/absent = whole-identity suppression.
   */
  suppressed_categories: z.array(z.string().min(1)).optional(),
});
export type IdentitySuppressedPayload = z.infer<typeof IdentitySuppressedPayloadSchema>;

export const IdentitySuppressedEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('identity.suppressed'),
  payload: IdentitySuppressedPayloadSchema,
});
export type IdentitySuppressedEvent = z.infer<typeof IdentitySuppressedEventSchema>;

// ── 5. identity.review_queued ────────────────────────────────────────────────
// Emitted: a probable merge lands in the review band → queued for a human (mirrors MergeReview).

export const IdentityReviewQueuedPayloadSchema = z.object({
  brand_id: z.string().uuid(),
  /** Stable id for the review item (mirrors MergeReview.review_id). */
  review_id: z.string().uuid(),
  /** The two candidate identities (mirrors MergeReview.brain_id_a/brain_id_b). */
  brain_id_a: z.string().uuid(),
  brain_id_b: z.string().uuid(),
  /** Why the pair was queued (mirrors MergeReview.trigger_reason). */
  trigger_reason: z.string().min(1),
  rule_version: z.string().min(1),
  /** Confidence + band — in the 'review' band by construction (not auto-committed). */
  verdict: ConfidenceVerdictSchema,
});
export type IdentityReviewQueuedPayload = z.infer<typeof IdentityReviewQueuedPayloadSchema>;

export const IdentityReviewQueuedEventSchema = EventEnvelopeBaseSchema.extend({
  event_name: z.literal('identity.review_queued'),
  payload: IdentityReviewQueuedPayloadSchema,
});
export type IdentityReviewQueuedEvent = z.infer<typeof IdentityReviewQueuedEventSchema>;

// ── Topic suffixes ({env}.identity.{event}.v1) ───────────────────────────────

export const IDENTITY_MINTED_TOPIC_SUFFIX = 'identity.minted.v1' as const;
export const IDENTITY_LINKED_TOPIC_SUFFIX = 'identity.linked.v1' as const;
export const IDENTITY_MERGED_TOPIC_SUFFIX = 'identity.merged.v1' as const;
export const IDENTITY_SUPPRESSED_TOPIC_SUFFIX = 'identity.suppressed.v1' as const;
export const IDENTITY_REVIEW_QUEUED_TOPIC_SUFFIX = 'identity.review_queued.v1' as const;

// ── Avro subjects (Apicurio registry — additive evolution only) ──────────────

export const IDENTITY_MINTED_AVRO_SUBJECT = 'brain.identity.minted.v1' as const;
export const IDENTITY_LINKED_AVRO_SUBJECT = 'brain.identity.linked.v1' as const;
export const IDENTITY_MERGED_AVRO_SUBJECT = 'brain.identity.merged.v1' as const;
export const IDENTITY_SUPPRESSED_AVRO_SUBJECT = 'brain.identity.suppressed.v1' as const;
export const IDENTITY_REVIEW_QUEUED_AVRO_SUBJECT = 'brain.identity.review_queued.v1' as const;

// ── All identity event schemas (for codegen — mirrors M1_EVENT_SCHEMAS) ───────

export const IDENTITY_EVENT_SCHEMAS = {
  'identity.minted': IdentityMintedEventSchema,
  'identity.linked': IdentityLinkedEventSchema,
  'identity.merged': IdentityMergedEventSchema,
  'identity.suppressed': IdentitySuppressedEventSchema,
  'identity.review_queued': IdentityReviewQueuedEventSchema,
} as const;
