/**
 * MatcherRegistry.test.ts — runtime registry + deterministic-first (D-5) enforcement.
 *
 * Proves:
 *   (1) only the deterministic matcher is ENABLED; the four deferred strategies are registered-DISABLED.
 *   (2) a disabled matcher's match() — and the registry's invoke() of it — throws NotImplementedYet,
 *       NEVER a fabricated verdict.
 *   (3) runEnabled() iterates ONLY enabled matchers.
 *   (4) duplicate / unknown id guards.
 */
import { describe, it, expect } from 'vitest';
import { NotImplementedYet, type MatcherInput } from '@brain/contracts';
import {
  MatcherRegistry,
  DuplicateMatcherError,
  UnknownMatcherError,
  createDefaultMatcherRegistry,
} from './MatcherRegistry.js';
import { DeterministicUnionFindMatcher } from './DeterministicUnionFindMatcher.js';
import {
  ProbabilisticMatcher,
  MlMatcher,
  HouseholdMatcher,
  CrossDeviceMatcher,
} from './DisabledMatchers.js';

const BRAND = '00000000-0000-0000-0000-0000000000b1';
const input: MatcherInput = { brand_id: BRAND, identifiers: [], candidates: [] };

describe('DisabledMatchers — registered-DISABLED, never faked (D-5)', () => {
  const disabled = [
    new ProbabilisticMatcher(),
    new MlMatcher(),
    new HouseholdMatcher(),
    new CrossDeviceMatcher(),
  ];

  for (const m of disabled) {
    it(`${m.id} has status 'disabled-not-implemented' and match() throws NotImplementedYet`, () => {
      expect(m.status).toBe('disabled-not-implemented');
      expect(() => m.match(input)).toThrow(NotImplementedYet);
    });
  }
});

describe('MatcherRegistry', () => {
  it('the default registry: exactly one enabled (deterministic), four disabled', () => {
    const reg = createDefaultMatcherRegistry();
    expect(reg.list()).toHaveLength(5);
    const enabled = reg.enabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.id).toBe('deterministic-union-find');
  });

  it('runEnabled() iterates ONLY enabled matchers (never invokes a disabled one)', () => {
    const reg = createDefaultMatcherRegistry();
    // Use a real overlap so the deterministic matcher returns a verdict (and no disabled throws).
    const results = reg.runEnabled(input);
    expect(results).toHaveLength(1);
    expect(results[0]!.matcher_id).toBe('deterministic-union-find');
    expect(results[0]!.verdict.matcher_id).toBe('deterministic-union-find');
  });

  it('invoke() of the enabled matcher returns its verdict', () => {
    const reg = createDefaultMatcherRegistry();
    const verdict = reg.invoke('deterministic-union-find', input);
    expect(verdict.matcher_id).toBe('deterministic-union-find');
    expect(verdict.score).toBe(0); // no candidates → none
  });

  it('invoke() of a DISABLED matcher is REJECTED with NotImplementedYet', () => {
    const reg = createDefaultMatcherRegistry();
    expect(() => reg.invoke('ml-embedding-similarity', input)).toThrow(NotImplementedYet);
    expect(() => reg.invoke('probabilistic-fellegi-sunter', input)).toThrow(NotImplementedYet);
    expect(() => reg.invoke('household-clustering', input)).toThrow(NotImplementedYet);
    expect(() => reg.invoke('cross-device-graph', input)).toThrow(NotImplementedYet);
  });

  it('rejects duplicate registration and unknown ids', () => {
    const reg = new MatcherRegistry().register(new DeterministicUnionFindMatcher());
    expect(() => reg.register(new DeterministicUnionFindMatcher())).toThrow(DuplicateMatcherError);
    expect(() => reg.require('nope')).toThrow(UnknownMatcherError);
    expect(() => reg.invoke('nope', input)).toThrow(UnknownMatcherError);
    expect(reg.get('nope')).toBeUndefined();
    expect(reg.has('deterministic-union-find')).toBe(true);
  });
});
