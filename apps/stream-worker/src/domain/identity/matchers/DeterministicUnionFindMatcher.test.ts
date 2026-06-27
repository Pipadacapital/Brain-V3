/**
 * DeterministicUnionFindMatcher.test.ts — the ONE enabled matcher.
 *
 * Proves:
 *   (1) match() emits a deterministic verdict (score 100, band 'exact') on a strong salted-hash
 *       overlap, and score 0 / band 'none' otherwise — never a fabricated sub-100 score.
 *   (2) only STRONG identifiers (strong / strong_on_link) drive a match; medium (device/anon) does not.
 *   (3) tenant isolation: candidates from a different brand_id are ignored.
 *   (4) the batch union-find produces an order-independent graph whose canonical = lowest UUID and
 *       whose merge_ids match the wrapped IdentityResolver.computeMergeId (stream ≡ backfill).
 */
import { describe, it, expect } from 'vitest';
import type { Identifier, MatcherInput } from '@brain/contracts';
import { ConfidenceVerdictSchema } from '@brain/contracts';
import { DeterministicUnionFindMatcher } from './DeterministicUnionFindMatcher.js';
import { IdentityResolver, RULE_VERSION } from '../IdentityResolver.js';
import type { IdentifierBrainEdge } from './union-find.js';

const BRAND = '00000000-0000-0000-0000-0000000000b1';
const OTHER_BRAND = '00000000-0000-0000-0000-0000000000b2';
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const deviceHash = 'd'.repeat(64);

const ident = (over: Partial<Identifier>): Identifier => ({
  brand_id: BRAND,
  identifier_type: 'email',
  identifier_hash: hashA,
  tier: 'strong',
  ...over,
});

describe('DeterministicUnionFindMatcher — Matcher port + identity', () => {
  const matcher = new DeterministicUnionFindMatcher();

  it('is the enabled deterministic matcher (id / version=rule_version / status)', () => {
    expect(matcher.id).toBe('deterministic-union-find');
    expect(matcher.version).toBe(RULE_VERSION);
    expect(matcher.status).toBe('enabled');
  });

  it('exact strong-hash overlap → score 100, band "exact", combo of matched members', () => {
    const input: MatcherInput = {
      brand_id: BRAND,
      identifiers: [ident({ identifier_type: 'email', identifier_hash: hashA })],
      candidates: [ident({ identifier_type: 'email', identifier_hash: hashA })],
    };
    const verdict = matcher.match(input);
    expect(verdict.score).toBe(100);
    expect(verdict.band).toBe('exact');
    expect(verdict.matcher_id).toBe('deterministic-union-find');
    expect(verdict.rule_version).toBe(RULE_VERSION);
    expect(verdict.reasons).toContain('strong_key:email');
    expect(verdict.identifier_combo).toEqual([
      { identifier_type: 'email', identifier_hash: hashA },
    ]);
    // Verdict conforms to the contract schema (integer 0-100, never money).
    expect(() => ConfidenceVerdictSchema.parse(verdict)).not.toThrow();
  });

  it('no overlapping candidate → score 0, band "none", empty combo (mint a fresh identity)', () => {
    const verdict = matcher.match({
      brand_id: BRAND,
      identifiers: [ident({ identifier_hash: hashA })],
      candidates: [ident({ identifier_hash: hashB })],
    });
    expect(verdict.score).toBe(0);
    expect(verdict.band).toBe('none');
    expect(verdict.identifier_combo).toEqual([]);
    expect(verdict.reasons).toEqual(['no_strong_match']);
    expect(() => ConfidenceVerdictSchema.parse(verdict)).not.toThrow();
  });

  it('MEDIUM identifiers (device/anon) never drive a deterministic match', () => {
    const verdict = matcher.match({
      brand_id: BRAND,
      identifiers: [ident({ identifier_type: 'device_id', identifier_hash: deviceHash, tier: 'medium' })],
      candidates: [ident({ identifier_type: 'device_id', identifier_hash: deviceHash, tier: 'medium' })],
    });
    // Medium-only overlap is resolve-only adoption, NOT a merge-key match → no exact verdict.
    expect(verdict.score).toBe(0);
    expect(verdict.band).toBe('none');
    expect(verdict.reasons).toEqual(['no_strong_identifier']);
  });

  it('strong_on_link (storefront_customer_id) counts as a strong key', () => {
    const verdict = matcher.match({
      brand_id: BRAND,
      identifiers: [ident({ identifier_type: 'storefront_customer_id', identifier_hash: hashB, tier: 'strong_on_link' })],
      candidates: [ident({ identifier_type: 'storefront_customer_id', identifier_hash: hashB, tier: 'strong_on_link' })],
    });
    expect(verdict.score).toBe(100);
    expect(verdict.reasons).toContain('strong_key:storefront_customer_id');
  });

  it('TENANT ISOLATION: a candidate from another brand_id is ignored', () => {
    const verdict = matcher.match({
      brand_id: BRAND,
      identifiers: [ident({ identifier_hash: hashA })],
      candidates: [ident({ brand_id: OTHER_BRAND, identifier_hash: hashA })],
    });
    expect(verdict.score).toBe(0);
    expect(verdict.band).toBe('none');
  });

  it('dedupes reason codes but keeps every matched member in the combo', () => {
    const verdict = matcher.match({
      brand_id: BRAND,
      identifiers: [
        ident({ identifier_type: 'email', identifier_hash: hashA }),
        ident({ identifier_type: 'email', identifier_hash: hashB }),
      ],
      candidates: [
        ident({ identifier_type: 'email', identifier_hash: hashA }),
        ident({ identifier_type: 'email', identifier_hash: hashB }),
      ],
    });
    expect(verdict.reasons).toEqual(['strong_key:email']); // deduped
    expect(verdict.identifier_combo).toHaveLength(2); // both members retained
  });

  describe('batchUnionFind / batchResolve — backfill ≡ stream', () => {
    const A = '00000000-0000-0000-0000-00000000000a';
    const B = '00000000-0000-0000-0000-00000000000b';
    const C = '00000000-0000-0000-0000-00000000000c';
    const edges: IdentifierBrainEdge[] = [
      { identifier_key: `email:${hashA}`, brain_id: B },
      { identifier_key: `email:${hashA}`, brain_id: C },
      { identifier_key: `phone:${hashB}`, brain_id: C },
      { identifier_key: `phone:${hashB}`, brain_id: A },
    ];

    it('folds the component to the lowest-UUID canonical', () => {
      const { components } = matcher.batchUnionFind(edges);
      expect(components).toEqual([{ canonical: A, members: [A, B, C] }]);
    });

    it('emits MergeSpecs whose merge_id == the wrapped resolver.computeMergeId (D-4)', () => {
      const resolver = new IdentityResolver();
      const { merges } = matcher.batchResolve(BRAND, edges);
      // Non-canonical members B and C each merge into canonical A.
      expect(merges).toHaveLength(2);
      for (const m of merges) {
        expect(m.canonicalBrainId).toBe(A);
        expect(m.mergeId).toBe(resolver.computeMergeId(BRAND, A, m.mergedBrainId));
      }
      expect(merges.map((m) => m.mergedBrainId).sort()).toEqual([B, C]);
    });
  });
});
