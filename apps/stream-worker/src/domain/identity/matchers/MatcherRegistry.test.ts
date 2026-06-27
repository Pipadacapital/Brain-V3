/**
 * MatcherRegistry.test.ts — runtime registry + deterministic-first (D-5) enforcement.
 *
 * Proves:
 *   (1) the deterministic + the rule-based probabilistic matchers are ENABLED; ML / household /
 *       cross-device remain registered-DISABLED.
 *   (2) a disabled matcher's match() — and the registry's invoke() of it — throws NotImplementedYet,
 *       NEVER a fabricated verdict.
 *   (3) runEnabled() iterates ONLY enabled matchers.
 *   (4) duplicate / unknown id guards.
 */
import { describe, it, expect } from 'vitest';
import {
  NotImplementedYet,
  IDENTITY_MATCHER_REGISTRY,
  type MatcherInput,
} from '@brain/contracts';
import {
  MatcherRegistry,
  DuplicateMatcherError,
  UnknownMatcherError,
  createDefaultMatcherRegistry,
} from './MatcherRegistry.js';
import { DeterministicUnionFindMatcher } from './DeterministicUnionFindMatcher.js';
import {
  MlMatcher,
  HouseholdMatcher,
  CrossDeviceMatcher,
} from './DisabledMatchers.js';

const BRAND = '00000000-0000-0000-0000-0000000000b1';
const input: MatcherInput = { brand_id: BRAND, identifiers: [], candidates: [] };

describe('DisabledMatchers — registered-DISABLED, never faked (D-5)', () => {
  const disabled = [
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
  it('the default registry: two enabled (deterministic + probabilistic), three disabled', () => {
    const reg = createDefaultMatcherRegistry();
    expect(reg.list()).toHaveLength(5);
    const enabled = reg.enabled();
    expect(enabled).toHaveLength(2);
    expect(enabled.map((m) => m.id).sort()).toEqual(
      ['deterministic-union-find', 'probabilistic-fellegi-sunter'].sort(),
    );
  });

  it('runEnabled() iterates ONLY enabled matchers (never invokes a disabled one)', () => {
    const reg = createDefaultMatcherRegistry();
    // Empty input → both enabled matchers return a 'none' verdict; no disabled matcher is invoked.
    const results = reg.runEnabled(input);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.matcher_id).sort()).toEqual(
      ['deterministic-union-find', 'probabilistic-fellegi-sunter'].sort(),
    );
  });

  it('invoke() of the enabled matcher returns its verdict', () => {
    const reg = createDefaultMatcherRegistry();
    const verdict = reg.invoke('deterministic-union-find', input);
    expect(verdict.matcher_id).toBe('deterministic-union-find');
    expect(verdict.score).toBe(0); // no candidates → none
  });

  it('invoke() of the probabilistic matcher returns its verdict (now ENABLED, never throws)', () => {
    const reg = createDefaultMatcherRegistry();
    const verdict = reg.invoke('probabilistic-fellegi-sunter', input);
    expect(verdict.matcher_id).toBe('probabilistic-fellegi-sunter');
    expect(verdict.score).toBe(0); // no weak-signal agreement on empty input → band 'none'
    expect(verdict.band).toBe('none');
  });

  it('invoke() of a DISABLED matcher is REJECTED with NotImplementedYet', () => {
    const reg = createDefaultMatcherRegistry();
    expect(() => reg.invoke('ml-embedding-similarity', input)).toThrow(NotImplementedYet);
    expect(() => reg.invoke('household-clustering', input)).toThrow(NotImplementedYet);
    expect(() => reg.invoke('cross-device-graph', input)).toThrow(NotImplementedYet);
  });

  it('runtime registry and the @brain/contracts descriptor registry AGREE on ids+status (no drift)', () => {
    const reg = createDefaultMatcherRegistry();

    // Same set of ids, same cardinality (all 5 matchers enumerated on both sides).
    const runtimeIds = reg
      .list()
      .map((m) => m.id)
      .sort();
    const descriptorIds = IDENTITY_MATCHER_REGISTRY.map((d) => d.id).sort();
    expect(runtimeIds).toEqual(descriptorIds);
    expect(runtimeIds).toHaveLength(5);

    // Each id agrees on lifecycle status between the runtime instance and its descriptor.
    for (const descriptor of IDENTITY_MATCHER_REGISTRY) {
      const runtime = reg.require(descriptor.id);
      expect(runtime.status).toBe(descriptor.status);
    }

    // And the enabled/disabled split matches: exactly two enabled on both sides.
    const enabledDescriptors = IDENTITY_MATCHER_REGISTRY.filter((d) => d.status === 'enabled');
    expect(enabledDescriptors.map((d) => d.id).sort()).toEqual(reg.enabled().map((m) => m.id).sort());
    expect(enabledDescriptors).toHaveLength(2);
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
