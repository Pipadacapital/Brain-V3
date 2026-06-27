/**
 * DecisionEngine.test.ts — pure-domain unit tests for the Identity Decision Engine.
 *
 * Proves:
 *   1. Every ResolveOutcome.action maps to the correct contract IdentityDecision command, and each
 *      decision validates against the Wave-1 IdentityDecisionSchema (it is a real contract Command).
 *   2. REVERSIBILITY: every command carries its declared inverse compensation, targeting its own
 *      subject ids; tampering the compensation is rejected by assertReversible.
 *   3. Merge → Unmerge → remerge round-trips back to the original merge ids (reverse-of-reverse).
 *   4. EVIDENCE ROUND-TRIP: buildEvidence preserves the verdict's structured identifier_combo
 *      (the field that was previously lost as []) and persists/reads it intact via the EvidenceStore.
 *
 * @effort("deterministic") — no IO, no model calls.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  IdentityDecisionSchema,
  ConfidenceVerdictSchema,
  type ConfidenceVerdict,
} from '@brain/contracts';
import { DecisionEngine, type DecisionContext } from './DecisionEngine.js';
import type { ResolveOutcome, ExtractedIdentifier } from '../IdentityResolver.js';
import { InMemoryEvidenceStore } from '../../../infrastructure/identity/InMemoryEvidenceStore.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const BRAND = '11111111-1111-1111-1111-111111111111';
const BRAIN_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const BRAIN_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const RULE = 'v1-deterministic';
const NOW = '2026-06-27T00:00:00.000Z';

const h = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const EMAIL_HASH = h('email:user@example.com');
const PHONE_HASH = h('phone:+919876543210');

const emailId: ExtractedIdentifier = {
  type: 'email',
  hash: EMAIL_HASH,
  tier: 'strong',
  confidence: 'high',
};
const phoneId: ExtractedIdentifier = {
  type: 'phone',
  hash: PHONE_HASH,
  tier: 'strong',
  confidence: 'high',
};

/** A deterministic exact verdict carrying a 2-member identifier_combo (the round-trip subject). */
const verdict: ConfidenceVerdict = {
  score: 100,
  band: 'exact',
  reasons: ['strong_key:email', 'strong_key:phone'],
  matcher_id: 'deterministic-union-find',
  rule_version: RULE,
  identifier_combo: [
    { identifier_type: 'email', identifier_hash: EMAIL_HASH },
    { identifier_type: 'phone', identifier_hash: PHONE_HASH },
  ],
};

const baseOutcome: Omit<ResolveOutcome, 'action' | 'brainId' | 'newLinks'> = {
  phoneGuardUpdates: [],
  routeToReview: false,
  contactPiiWrites: [],
};

function ctx(outcome: ResolveOutcome, matchedBrainIds?: string[]): DecisionContext {
  return { brand_id: BRAND, rule_version: RULE, decided_at: NOW, outcome, verdict, matchedBrainIds };
}

const engine = new DecisionEngine();

// ── 1 + 2. Command mapping + reversibility, per action ──────────────────────────

describe('DecisionEngine — command mapping is contract-valid + reversible', () => {
  it('minted → Mint, inverse tombstone_brain_id targeting the minted brain_id', () => {
    const d = engine.decide(ctx({ ...baseOutcome, action: 'minted', brainId: BRAIN_A, newLinks: [emailId, phoneId] }));
    expect(d.command).toBe('mint');
    expect(IdentityDecisionSchema.safeParse(d).success).toBe(true);
    expect(d.compensation).toEqual({ kind: 'tombstone_brain_id', brain_id: BRAIN_A });
    expect(() => engine.assertReversible(d)).not.toThrow();
  });

  it('linked → Link, inverse unlink_identifiers listing exactly the new link hashes', () => {
    const d = engine.decide(ctx({ ...baseOutcome, action: 'linked', brainId: BRAIN_A, newLinks: [phoneId] }));
    expect(d.command).toBe('link');
    expect(IdentityDecisionSchema.safeParse(d).success).toBe(true);
    expect(d.compensation).toEqual({
      kind: 'unlink_identifiers',
      brain_id: BRAIN_A,
      identifier_hashes: [PHONE_HASH],
    });
    expect(() => engine.assertReversible(d)).not.toThrow();
  });

  it('merged → Merge, inverse unmerge with the same merge_id/canonical/merged', () => {
    const mergeId = engineMergeId();
    const d = engine.decide(
      ctx({
        ...baseOutcome,
        action: 'merged',
        brainId: BRAIN_A,
        newLinks: [],
        merge: { canonicalBrainId: BRAIN_A, mergedBrainId: BRAIN_B, mergeId },
      }),
    );
    expect(d.command).toBe('merge');
    expect(IdentityDecisionSchema.safeParse(d).success).toBe(true);
    expect(d.compensation).toEqual({
      kind: 'unmerge',
      merge_id: mergeId,
      canonical_brain_id: BRAIN_A,
      merged_brain_id: BRAIN_B,
    });
    expect(() => engine.assertReversible(d)).not.toThrow();
  });

  it('skipped+routeToReview → RouteToReview, inverse withdraw_review for the queued id', () => {
    const d = engine.decide(
      ctx(
        { ...baseOutcome, action: 'skipped', brainId: BRAIN_A, newLinks: [], routeToReview: true, reviewReason: 'cycle-guard: alias chain collision' },
        [BRAIN_A, BRAIN_B],
      ),
    );
    expect(d.command).toBe('route_to_review');
    expect(IdentityDecisionSchema.safeParse(d).success).toBe(true);
    if (d.command === 'route_to_review') {
      expect(d.brain_id_a).toBe(BRAIN_A);
      expect(d.brain_id_b).toBe(BRAIN_B);
      expect(d.compensation).toEqual({ kind: 'withdraw_review', review_id: d.review_id });
    }
    expect(() => engine.assertReversible(d)).not.toThrow();
  });

  it('phoneGuardUpdates.suppress → Suppress, inverse lift_suppression for the same identifier', () => {
    const suppressedUntil = new Date('2026-07-27T00:00:00.000Z');
    const [d, ...rest] = engine.deriveSuppressions(
      ctx({
        ...baseOutcome,
        action: 'minted',
        brainId: BRAIN_A,
        newLinks: [emailId],
        phoneGuardUpdates: [
          { identifier_type: 'phone', identifier_value: PHONE_HASH, profile_count: 11, suppress: true, suppressed_until: suppressedUntil },
        ],
      }),
    );
    expect(rest).toHaveLength(0);
    expect(d!.command).toBe('suppress');
    expect(IdentityDecisionSchema.safeParse(d).success).toBe(true);
    if (d!.command === 'suppress') {
      expect(d!.identifier_hash).toBe(PHONE_HASH);
      expect(d!.suppressed_until).toBe(suppressedUntil.toISOString());
      expect(d!.compensation).toEqual({ kind: 'lift_suppression', identifier_type: 'phone', identifier_hash: PHONE_HASH });
    }
    expect(() => engine.assertReversible(d!)).not.toThrow();
  });

  it('unmerge (admin) → Unmerge, inverse remerge with the same ids', () => {
    const mergeId = engineMergeId();
    const d = engine.unmerge({
      brand_id: BRAND,
      rule_version: RULE,
      decided_at: NOW,
      merge_id: mergeId,
      canonical_brain_id: BRAIN_A,
      merged_brain_id: BRAIN_B,
      reason: 'operator review reversal',
    });
    expect(d.command).toBe('unmerge');
    expect(IdentityDecisionSchema.safeParse(d).success).toBe(true);
    expect(d.compensation).toEqual({
      kind: 'remerge',
      merge_id: mergeId,
      canonical_brain_id: BRAIN_A,
      merged_brain_id: BRAIN_B,
    });
    expect(() => engine.assertReversible(d)).not.toThrow();
  });
});

// ── 2b. assertReversible rejects a tampered inverse ─────────────────────────────

describe('DecisionEngine — assertReversible rejects a broken inverse', () => {
  it('throws when the compensation kind is not the declared inverse', () => {
    const d = engine.decide(ctx({ ...baseOutcome, action: 'minted', brainId: BRAIN_A, newLinks: [emailId] }));
    const tampered = { ...d, compensation: { kind: 'unmerge', merge_id: BRAIN_A, canonical_brain_id: BRAIN_A, merged_brain_id: BRAIN_B } } as typeof d;
    expect(() => engine.assertReversible(tampered)).toThrow(/non-reversible/);
  });

  it('throws when the inverse targets the wrong subject id', () => {
    const d = engine.decide(ctx({ ...baseOutcome, action: 'minted', brainId: BRAIN_A, newLinks: [emailId] }));
    const tampered = { ...d, compensation: { kind: 'tombstone_brain_id', brain_id: BRAIN_B } } as typeof d;
    expect(() => engine.assertReversible(tampered)).toThrow(/brain_id mismatch/);
  });
});

// ── 3. Reverse-of-reverse round-trip (Merge → Unmerge → remerge points back) ────

describe('DecisionEngine — Merge/Unmerge round-trip', () => {
  it('unmerge built from a Merge compensation re-points (remerge) to the original merge', () => {
    const mergeId = engineMergeId();
    const merge = engine.decide(
      ctx({ ...baseOutcome, action: 'merged', brainId: BRAIN_A, newLinks: [], merge: { canonicalBrainId: BRAIN_A, mergedBrainId: BRAIN_B, mergeId } }),
    );
    const comp = engine.compensationFor(merge);
    expect(comp.kind).toBe('unmerge');
    if (comp.kind !== 'unmerge') throw new Error('unreachable');

    const admin = engine.unmerge({
      brand_id: BRAND,
      rule_version: RULE,
      decided_at: NOW,
      merge_id: comp.merge_id,
      canonical_brain_id: comp.canonical_brain_id,
      merged_brain_id: comp.merged_brain_id,
      reason: 'undo',
    });
    // The inverse of the inverse references the SAME merge — fully reversible.
    expect(admin.compensation).toEqual({
      kind: 'remerge',
      merge_id: mergeId,
      canonical_brain_id: BRAIN_A,
      merged_brain_id: BRAIN_B,
    });
  });
});

// ── 4. Evidence identifier_combo round-trip ─────────────────────────────────────

describe('DecisionEngine — evidence preserves identifier_combo (was lost as [])', () => {
  it('buildEvidence carries the full structured identifier_combo from the verdict', () => {
    const d = engine.decide(ctx({ ...baseOutcome, action: 'minted', brainId: BRAIN_A, newLinks: [emailId, phoneId] }));
    const ev = engine.buildEvidence(d, verdict, { thresholds: { phone_guard_threshold: 10 } });
    expect(ev.identifier_combo).toEqual(verdict.identifier_combo);
    expect(ev.identifier_combo).toHaveLength(2);
    expect(ev.score).toBe(100);
    expect(ev.band).toBe('exact');
    expect(ev.thresholds).toEqual({ phone_guard_threshold: 10 });
    expect(ev.decision_id).toBe(DecisionEngine.decisionId(d));
  });

  it('round-trips through the EvidenceStore intact (not [])', async () => {
    const store = new InMemoryEvidenceStore();
    const d = engine.decide(ctx({ ...baseOutcome, action: 'minted', brainId: BRAIN_A, newLinks: [emailId, phoneId] }));
    const ev = engine.buildEvidence(d, verdict);
    await store.put(ev);
    const got = await store.get({ brand_id: BRAND, decision_id: ev.decision_id });
    expect(got).not.toBeNull();
    expect(got!.identifier_combo).toEqual(verdict.identifier_combo);
    // Mutating the source verdict after persist must NOT corrupt the stored evidence.
    verdict.identifier_combo.push({ identifier_type: 'device_id', identifier_hash: h('x') });
    const reread = await store.get({ brand_id: BRAND, decision_id: ev.decision_id });
    expect(reread!.identifier_combo).toHaveLength(2);
    verdict.identifier_combo.pop(); // restore fixture
  });

  it('the verdict round-trips even when validated against the canonical schema', () => {
    expect(ConfidenceVerdictSchema.safeParse(verdict).success).toBe(true);
  });
});

// ── 5. decisionId is deterministic (idempotent ledger + evidence) ───────────────

describe('DecisionEngine — decisionId is deterministic', () => {
  it('same decision → same id across calls', () => {
    const a = engine.decide(ctx({ ...baseOutcome, action: 'minted', brainId: BRAIN_A, newLinks: [emailId] }));
    const b = engine.decide(ctx({ ...baseOutcome, action: 'minted', brainId: BRAIN_A, newLinks: [emailId] }));
    expect(DecisionEngine.decisionId(a)).toBe(DecisionEngine.decisionId(b));
  });

  it('merge decisionId equals the deterministic merge_id', () => {
    const mergeId = engineMergeId();
    const d = engine.decide(
      ctx({ ...baseOutcome, action: 'merged', brainId: BRAIN_A, newLinks: [], merge: { canonicalBrainId: BRAIN_A, mergedBrainId: BRAIN_B, mergeId } }),
    );
    expect(DecisionEngine.decisionId(d)).toBe(mergeId);
  });
});

/** A deterministic, schema-valid merge_id UUID for fixtures (mirrors IdentityResolver D-4). */
function engineMergeId(): string {
  const hex = createHash('sha256').update(`${BRAND}||${BRAIN_A}||${BRAIN_B}||${RULE}`, 'utf8').digest('hex');
  const x = hex.slice(0, 32);
  return [
    x.slice(0, 8),
    x.slice(8, 12),
    '5' + x.slice(13, 16),
    ((parseInt(x[16]!, 16) & 0x3) | 0x8).toString(16) + x.slice(17, 20),
    x.slice(20, 32),
  ].join('-');
}
