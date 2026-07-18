/**
 * IdentityEventPublisher — the OUTBOUND port for the identity.* domain-event lane, plus the
 * PURE mapping from a resolver `ResolveOutcome` to the wire payloads.
 *
 * HEXAGONAL: this is DOMAIN — it imports NO infrastructure (no kafkajs, no @brain/observability,
 * no producer). It depends only on `node:crypto` and TYPE-ONLY contract shapes from @brain/contracts
 * (the leaf contract package is the identity domain vocabulary, never infra). The Kafka adapter that
 * fulfils this port lives in infrastructure/kafka/KafkaIdentityEventPublisher.ts.
 *
 * WHAT IT EMITS (mirrors packages/contracts/src/events/identity.events.v1.ts):
 *   minted action            → identity.minted        (brand-new brain_id)
 *   linked action            → identity.linked        (identifier attached to an existing brain_id)
 *   merged action            → identity.merged        (two brain_ids folded into one canonical)
 *   skipped + routeToReview   → identity.review_queued (cycle-guard / conflict → human review)
 *   (suppressed)             → identity.suppressed    (consent-driven; resolve() never returns it —
 *                              the port supports it for the consent lane, the mapper does not fake it)
 *
 * INVARIANTS:
 *  - tenant(brand_id) on every event (I-S01); the partition key is brand_id (set by the adapter).
 *  - HASH-ONLY (I-S02): payloads carry the 64-hex identifier hashes / brain_id / merge_id / review_id /
 *    rule_version / a ConfidenceVerdict — NEVER a raw email/phone (rawValue is dropped here).
 *  - DETERMINISTIC-first (D-5): the only live matcher is `deterministic-union-find`; the verdict is
 *    always score=100, band='exact'. No probabilistic band is ever produced.
 *  - confidence is an INTEGER 0-100 — never blended with money.
 *  - IDEMPOTENT: every event carries a deterministic `dedupeKey`; the adapter derives a deterministic
 *    event_id from (brand_id, event_name, dedupeKey, rule_version) so a replay re-emits the SAME
 *    event_id → downstream dedups on (brand_id, event_id). Replay-safe, commit-after-write.
 */
import { createHash } from 'node:crypto';
import type {
  IdentityMintedPayload,
  IdentityLinkedPayload,
  IdentityMergedPayload,
  IdentitySuppressedPayload,
  IdentityReviewQueuedPayload,
  ConfidenceVerdict,
  IdentifierComboMember,
} from '@brain/contracts';
import {
  RULE_VERSION,
  type ExtractedIdentifier,
  type ResolveOutcome,
} from './IdentityResolver.js';

/** The enabled deterministic matcher's id (mirrors IDENTITY_MATCHER_REGISTRY in @brain/contracts). */
export const DETERMINISTIC_MATCHER_ID = 'deterministic-union-find' as const;
/** Deterministic certainty: an exact strong-key match scores the integer 100, band 'exact'. */
const DETERMINISTIC_SCORE = 100 as const;
const DETERMINISTIC_BAND = 'exact' as const;

/**
 * A prepared identity event — the wire payload + the topic-selecting `eventName` + a deterministic
 * `dedupeKey` the adapter folds into the event_id for idempotent replay. Discriminated on eventName.
 */
export type PreparedIdentityEvent =
  | { eventName: 'identity.minted'; dedupeKey: string; payload: IdentityMintedPayload }
  | { eventName: 'identity.linked'; dedupeKey: string; payload: IdentityLinkedPayload }
  | { eventName: 'identity.merged'; dedupeKey: string; payload: IdentityMergedPayload }
  | { eventName: 'identity.suppressed'; dedupeKey: string; payload: IdentitySuppressedPayload }
  | { eventName: 'identity.review_queued'; dedupeKey: string; payload: IdentityReviewQueuedPayload };

/** Provenance threaded from the source Bronze event onto the published envelope. */
export interface IdentityPublishMeta {
  /** correlation_id of the source event (groups the whole flow). */
  correlationId?: string;
  /** event_id of the source Bronze event that caused this identity decision (causation chain). */
  causationId?: string;
}

/**
 * The IdentityEventPublisher PORT. The use-case calls `publish` AFTER the graph write
 * (commit-after-write). brand_id is the partition key. Implementations live in infrastructure.
 */
export interface IdentityEventPublisher {
  publish(
    brandId: string,
    events: PreparedIdentityEvent[],
    meta?: IdentityPublishMeta,
  ): Promise<void>;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

/**
 * Format a deterministic UUID (v5-like) from a SHA-256 of `input` — same scheme the resolver uses
 * for merge_id (D-4). Same input → same UUID (passes z.string().uuid()), so review_id / event_id
 * are replay-stable. Pure: no IO, no randomness.
 */
export function deterministicUuid(input: string): string {
  const hex = createHash('sha256').update(input, 'utf8').digest('hex');
  const h = hex.slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '5' + h.slice(13, 16), // version 5 (name-based SHA)
    ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20), // variant bits
    h.slice(20, 32),
  ].join('-');
}

/**
 * Derive the deterministic identity event_id from the dedupe key set — the SAME scheme the
 * (removed) KafkaIdentityEventPublisher stamped on the wire: same inputs → same id → replay-safe.
 * ADR-0015 WS3: the Silver identity stage folds this id into the provenance columns of the
 * direct dirty-set writes (source_event_id) so causation chains survive the consumer removal.
 */
export function deterministicEventId(
  brandId: string,
  eventName: string,
  dedupeKey: string,
): string {
  return deterministicUuid(`${brandId}||${eventName}||${dedupeKey}||${RULE_VERSION}`);
}

/** Tier priority for picking the single "anchor" identifier the singular payload field carries. */
const TIER_PRIORITY: Record<string, number> = {
  strong: 0,
  strong_on_link: 1,
  medium: 2,
  weak: 3,
};

/** Pick the highest-tier identifier as the event's anchor (the singular identifier_* fields). */
function pickAnchor(ids: ExtractedIdentifier[]): ExtractedIdentifier | undefined {
  if (ids.length === 0) return undefined;
  return [...ids].sort(
    (a, b) => (TIER_PRIORITY[a.tier] ?? 9) - (TIER_PRIORITY[b.tier] ?? 9),
  )[0];
}

/**
 * Build the deterministic ConfidenceVerdict for a decision. Score is the INTEGER 100 (exact match),
 * band 'exact', matcher = deterministic-union-find, rule_version pinned. identifier_combo is the
 * hash-only evidence set (I-S02). NEVER a float, NEVER money.
 */
export function buildDeterministicVerdict(
  ids: ExtractedIdentifier[],
  reasons: string[],
): ConfidenceVerdict {
  const identifier_combo: IdentifierComboMember[] = ids.map((i) => ({
    identifier_type: i.type,
    identifier_hash: i.hash,
  }));
  return {
    score: DETERMINISTIC_SCORE,
    band: DETERMINISTIC_BAND,
    reasons,
    matcher_id: DETERMINISTIC_MATCHER_ID,
    rule_version: RULE_VERSION,
    identifier_combo,
  };
}

/**
 * Map a resolver `ResolveOutcome` → the identity.* events to publish. PURE (no IO). Returns [] when
 * there is nothing to announce (e.g. an idempotent re-link with no new identifiers, or a non-emitting
 * action). The caller publishes the result AFTER the graph write.
 */
export function buildIdentityEvents(
  brandId: string,
  outcome: ResolveOutcome,
  identifiers: ExtractedIdentifier[],
): PreparedIdentityEvent[] {
  switch (outcome.action) {
    case 'minted': {
      // On a mint, all identifiers attach to the fresh brain_id (outcome.newLinks).
      const linkIds = outcome.newLinks.length > 0 ? outcome.newLinks : identifiers;
      const anchor = pickAnchor(linkIds);
      if (!anchor) return [];
      const anonymous_id = identifiers.find((i) => i.type === 'anon_id')?.hash ?? null;
      const verdict = buildDeterministicVerdict(linkIds, [
        'mint:first_sighting',
        `anchor:${anchor.type}`,
      ]);
      const payload: IdentityMintedPayload = {
        brand_id: brandId,
        brain_id: outcome.brainId,
        anonymous_id,
        identifier_type: anchor.type,
        tier: anchor.tier,
        identifier_hash: anchor.hash,
        rule_version: RULE_VERSION,
        verdict,
      };
      return [{ eventName: 'identity.minted', dedupeKey: outcome.brainId, payload }];
    }

    case 'linked': {
      // Only the NEWLY-attached identifiers; if none are new this is an idempotent re-link → emit nothing.
      const linkIds = outcome.newLinks;
      const anchor = pickAnchor(linkIds);
      if (!anchor) return [];
      const verdict = buildDeterministicVerdict(linkIds, [
        'link:existing_brain_id',
        `anchor:${anchor.type}`,
      ]);
      const payload: IdentityLinkedPayload = {
        brand_id: brandId,
        brain_id: outcome.brainId,
        identifier_type: anchor.type,
        tier: anchor.tier,
        identifier_hash: anchor.hash,
        rule_version: RULE_VERSION,
        verdict,
      };
      // dedupeKey = brain_id + anchor hash → distinct per newly-linked anchor, replay-stable.
      return [
        { eventName: 'identity.linked', dedupeKey: `${outcome.brainId}:${anchor.hash}`, payload },
      ];
    }

    case 'merged': {
      if (!outcome.merge) return [];
      const { canonicalBrainId, mergedBrainId, mergeId } = outcome.merge;
      // identifier_combo on the merged event is the identifier TYPES that drove the union (type-only,
      // never raw PII) — mirrors Customer360Merge.identifier_combo. The full hash evidence rides verdict.
      const identifier_combo = [...new Set(identifiers.map((i) => i.type))];
      const verdict = buildDeterministicVerdict(identifiers, ['merge:strong_key_union']);
      const payload: IdentityMergedPayload = {
        brand_id: brandId,
        merge_id: mergeId,
        canonical_brain_id: canonicalBrainId,
        merged_brain_id: mergedBrainId,
        identifier_combo,
        rule_version: RULE_VERSION,
        verdict,
      };
      return [{ eventName: 'identity.merged', dedupeKey: mergeId, payload }];
    }

    case 'skipped': {
      // Cycle-guard / conflict → a human-review item (mirrors the MergeReview graph write).
      if (!outcome.routeToReview) return [];
      const trigger_reason = outcome.reviewReason ?? 'cycle_guard:alias_loop';
      // Deterministic review_id (replay-stable) — same scheme the graph SHOULD key the MergeReview on.
      const reviewId = deterministicUuid(
        `${brandId}||review||${outcome.brainId}||${trigger_reason}||${RULE_VERSION}`,
      );
      const verdict = buildDeterministicVerdict(identifiers, ['route_to_review', trigger_reason]);
      const payload: IdentityReviewQueuedPayload = {
        brand_id: brandId,
        review_id: reviewId,
        // The resolver exposes only the canonical brain_id on a skipped route; mirror the graph write
        // (brain_id_a == brain_id_b == outcome.brainId). When a richer pair is surfaced later, fill both.
        brain_id_a: outcome.brainId,
        brain_id_b: outcome.brainId,
        trigger_reason,
        rule_version: RULE_VERSION,
        verdict,
      };
      return [{ eventName: 'identity.review_queued', dedupeKey: reviewId, payload }];
    }

    // 'suppressed' is consent-driven (a separate lane) — resolve() never returns it, and the mapper
    // never FAKES a suppression. The port still supports identity.suppressed for the consent path.
    case 'suppressed':
    default:
      return [];
  }
}
