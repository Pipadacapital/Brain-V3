/**
 * IdentityEventPublisher (mapper) — PURE unit + contract tests over buildIdentityEvents.
 *
 * Asserts the resolver-outcome → identity.* event mapping:
 *   - the right event per action (minted/linked/merged/review_queued; nothing for suppressed/no-op),
 *   - every produced payload VALIDATES against its @brain/contracts Zod schema (drift guard),
 *   - the verdict is the deterministic integer-100/'exact' verdict (never a float, never probabilistic),
 *   - HASH-ONLY: no raw PII (rawValue) leaks into any payload,
 *   - IDEMPOTENT: deterministic dedupeKey + review_id are stable across calls.
 *
 * No DB, no Kafka — buildIdentityEvents is a pure function.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  IdentityMintedPayloadSchema,
  IdentityLinkedPayloadSchema,
  IdentityMergedPayloadSchema,
  IdentityReviewQueuedPayloadSchema,
} from '@brain/contracts';
import {
  buildIdentityEvents,
  buildDeterministicVerdict,
  deterministicUuid,
  DETERMINISTIC_MATCHER_ID,
} from './IdentityEventPublisher.js';
import { RULE_VERSION, type ExtractedIdentifier, type ResolveOutcome } from './IdentityResolver.js';

const BRAND = randomUUID();
const BRAIN_A = randomUUID();
const BRAIN_B = randomUUID();
const MERGE_ID = randomUUID();

/** A 64-hex hash from a single hex char (satisfies IdentifierHashSchema). */
const hex = (c: string): string => c.repeat(64);

function id(
  type: ExtractedIdentifier['type'],
  hash: string,
  tier: ExtractedIdentifier['tier'],
  rawValue?: string,
): ExtractedIdentifier {
  return { type, hash, tier, confidence: tier === 'medium' ? 'low' : 'high', rawValue };
}

/** A baseline outcome; override per test. */
function outcome(partial: Partial<ResolveOutcome>): ResolveOutcome {
  return {
    action: 'minted',
    brainId: BRAIN_A,
    newLinks: [],
    phoneGuardUpdates: [],
    routeToReview: false,
    contactPiiWrites: [],
    ...partial,
  };
}

describe('buildDeterministicVerdict', () => {
  it('is the integer-100 / exact / deterministic-union-find verdict (never a float)', () => {
    const v = buildDeterministicVerdict([id('email', hex('a'), 'strong')], ['mint:first_sighting']);
    expect(v.score).toBe(100);
    expect(Number.isInteger(v.score)).toBe(true);
    expect(v.band).toBe('exact');
    expect(v.matcher_id).toBe(DETERMINISTIC_MATCHER_ID);
    expect(v.rule_version).toBe(RULE_VERSION);
    expect(v.identifier_combo).toEqual([{ identifier_type: 'email', identifier_hash: hex('a') }]);
  });
});

describe('buildIdentityEvents — minted', () => {
  const emailRaw = id('email', hex('a'), 'strong', 'user@example.com');
  const anon = id('anon_id', hex('c'), 'medium');
  const out = outcome({ action: 'minted', brainId: BRAIN_A, newLinks: [emailRaw, anon] });
  const events = buildIdentityEvents(BRAND, out, [emailRaw, anon]);

  it('emits exactly one identity.minted with the strong identifier as anchor', () => {
    expect(events).toHaveLength(1);
    expect(events[0]!.eventName).toBe('identity.minted');
    const p = events[0]!.payload as import('@brain/contracts').IdentityMintedPayload;
    expect(p.brain_id).toBe(BRAIN_A);
    expect(p.identifier_type).toBe('email');
    expect(p.tier).toBe('strong');
    expect(p.identifier_hash).toBe(hex('a'));
    expect(p.anonymous_id).toBe(hex('c')); // anon_id hash carried, not raw
  });

  it('payload validates against IdentityMintedPayloadSchema', () => {
    expect(IdentityMintedPayloadSchema.safeParse(events[0]!.payload).success).toBe(true);
  });

  it('HASH-ONLY: no raw PII (rawValue) leaks into the payload', () => {
    expect(JSON.stringify(events[0]!.payload)).not.toContain('user@example.com');
  });

  it('dedupeKey = brain_id (replay-stable)', () => {
    const again = buildIdentityEvents(BRAND, out, [emailRaw, anon]);
    expect(events[0]!.dedupeKey).toBe(BRAIN_A);
    expect(again[0]!.dedupeKey).toBe(events[0]!.dedupeKey);
  });
});

describe('buildIdentityEvents — linked', () => {
  const newPhone = id('phone', hex('b'), 'strong');
  const out = outcome({ action: 'linked', brainId: BRAIN_A, newLinks: [newPhone] });
  const events = buildIdentityEvents(BRAND, out, [newPhone, id('email', hex('a'), 'strong')]);

  it('emits identity.linked anchored on the newly-linked identifier', () => {
    expect(events).toHaveLength(1);
    expect(events[0]!.eventName).toBe('identity.linked');
    const p = events[0]!.payload as import('@brain/contracts').IdentityLinkedPayload;
    expect(p.brain_id).toBe(BRAIN_A);
    expect(p.identifier_hash).toBe(hex('b'));
    expect(IdentityLinkedPayloadSchema.safeParse(p).success).toBe(true);
  });

  it('emits NOTHING on an idempotent re-link (no new identifiers)', () => {
    const noNew = outcome({ action: 'linked', brainId: BRAIN_A, newLinks: [] });
    expect(buildIdentityEvents(BRAND, noNew, [id('email', hex('a'), 'strong')])).toEqual([]);
  });
});

describe('buildIdentityEvents — merged', () => {
  const ids = [id('email', hex('a'), 'strong'), id('phone', hex('b'), 'strong')];
  const out = outcome({
    action: 'merged',
    brainId: BRAIN_A,
    merge: { canonicalBrainId: BRAIN_A, mergedBrainId: BRAIN_B, mergeId: MERGE_ID },
  });
  const events = buildIdentityEvents(BRAND, out, ids);

  it('emits identity.merged with canonical/merged/merge_id + type-only identifier_combo', () => {
    expect(events).toHaveLength(1);
    expect(events[0]!.eventName).toBe('identity.merged');
    const p = events[0]!.payload as import('@brain/contracts').IdentityMergedPayload;
    expect(p.merge_id).toBe(MERGE_ID);
    expect(p.canonical_brain_id).toBe(BRAIN_A);
    expect(p.merged_brain_id).toBe(BRAIN_B);
    expect(p.identifier_combo.sort()).toEqual(['email', 'phone']);
    expect(events[0]!.dedupeKey).toBe(MERGE_ID);
    expect(IdentityMergedPayloadSchema.safeParse(p).success).toBe(true);
  });
});

describe('buildIdentityEvents — review_queued (cycle-guard)', () => {
  const ids = [id('email', hex('a'), 'strong')];
  const out = outcome({
    action: 'skipped',
    brainId: BRAIN_A,
    routeToReview: true,
    reviewReason: 'cycle-guard: alias chain collision',
  });
  const events = buildIdentityEvents(BRAND, out, ids);

  it('emits identity.review_queued with a deterministic review_id', () => {
    expect(events).toHaveLength(1);
    expect(events[0]!.eventName).toBe('identity.review_queued');
    const p = events[0]!.payload as import('@brain/contracts').IdentityReviewQueuedPayload;
    expect(p.brain_id_a).toBe(BRAIN_A);
    expect(p.brain_id_b).toBe(BRAIN_A);
    expect(p.trigger_reason).toContain('cycle-guard');
    expect(IdentityReviewQueuedPayloadSchema.safeParse(p).success).toBe(true);
  });

  it('review_id is replay-stable (same outcome → same review_id) and a valid uuid', () => {
    const again = buildIdentityEvents(BRAND, out, ids);
    const p1 = events[0]!.payload as import('@brain/contracts').IdentityReviewQueuedPayload;
    const p2 = again[0]!.payload as import('@brain/contracts').IdentityReviewQueuedPayload;
    expect(p1.review_id).toBe(p2.review_id);
    expect(p1.review_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('buildIdentityEvents — non-emitting actions', () => {
  it('emits nothing for a phone-guard/consent suppression (never faked)', () => {
    expect(buildIdentityEvents(BRAND, outcome({ action: 'suppressed' }), [])).toEqual([]);
  });
  it('emits nothing for a plain skipped (no route-to-review)', () => {
    expect(buildIdentityEvents(BRAND, outcome({ action: 'skipped', routeToReview: false }), [])).toEqual([]);
  });
});

describe('deterministicUuid', () => {
  it('is stable and a valid v5-shaped uuid', () => {
    const a = deterministicUuid('x||y||z');
    const b = deterministicUuid('x||y||z');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicUuid('different')).not.toBe(a);
  });
});
