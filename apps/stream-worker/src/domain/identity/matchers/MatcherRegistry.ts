/**
 * MatcherRegistry — the runtime registry of identity matchers.
 *
 * Holds the registered `Matcher` instances and enforces the deterministic-first invariant (D-5)
 * at runtime:
 *   - `enabled()`    returns ONLY `status === 'enabled'` matchers (currently just the
 *                    DeterministicUnionFindMatcher); `runEnabled()` iterates exactly those.
 *   - `invoke(id)`   REJECTS a disabled invoke loudly: a `disabled-not-implemented` matcher throws
 *                    `NotImplementedYet` rather than fabricate a verdict.
 *
 * This is the runtime twin of the static IDENTITY_MATCHER_REGISTRY descriptor list in
 * @brain/contracts: the descriptor list says which matchers EXIST + their lifecycle; this object
 * holds the live instances and gates invocation. Pure domain — no IO.
 */
import {
  DisabledMatcher,
  NotImplementedYet,
  type Matcher,
  type MatcherInput,
  type ConfidenceVerdict,
} from '@brain/contracts';
import { DeterministicUnionFindMatcher } from './DeterministicUnionFindMatcher.js';
import {
  ProbabilisticMatcher,
  MlMatcher,
  HouseholdMatcher,
  CrossDeviceMatcher,
} from './DisabledMatchers.js';

/** Thrown when two matchers are registered under the same id (a wiring bug). */
export class DuplicateMatcherError extends Error {
  constructor(id: string) {
    super(`[matcher-registry] a matcher with id "${id}" is already registered`);
    this.name = 'DuplicateMatcherError';
  }
}

/** Thrown when an id is requested/invoked that was never registered. */
export class UnknownMatcherError extends Error {
  constructor(id: string) {
    super(`[matcher-registry] no matcher registered with id "${id}"`);
    this.name = 'UnknownMatcherError';
  }
}

export class MatcherRegistry {
  private readonly matchers = new Map<string, Matcher>();

  /** Register a matcher. Throws DuplicateMatcherError on an id collision. Chainable. */
  register(matcher: Matcher): this {
    if (this.matchers.has(matcher.id)) throw new DuplicateMatcherError(matcher.id);
    this.matchers.set(matcher.id, matcher);
    return this;
  }

  /** Whether a matcher id is registered. */
  has(id: string): boolean {
    return this.matchers.has(id);
  }

  /** The matcher for an id, or undefined. */
  get(id: string): Matcher | undefined {
    return this.matchers.get(id);
  }

  /** The matcher for an id, or throw UnknownMatcherError. */
  require(id: string): Matcher {
    const m = this.matchers.get(id);
    if (!m) throw new UnknownMatcherError(id);
    return m;
  }

  /** All registered matchers (insertion order). */
  list(): Matcher[] {
    return [...this.matchers.values()];
  }

  /** ONLY the enabled matchers — the ones whose `match()` is live. */
  enabled(): Matcher[] {
    return this.list().filter((m) => m.status === 'enabled');
  }

  /**
   * Invoke a SPECIFIC matcher by id. Rejects a disabled invoke (D-5): a
   * `disabled-not-implemented` matcher throws `NotImplementedYet` — it is never faked.
   */
  invoke(id: string, input: MatcherInput): ConfidenceVerdict {
    const m = this.require(id);
    if (m.status !== 'enabled') {
      // Loud, explicit rejection — never a fabricated verdict.
      if (m instanceof DisabledMatcher) throw new NotImplementedYet(m.id, m.strategy);
      throw new NotImplementedYet(m.id, 'probabilistic');
    }
    return m.match(input);
  }

  /**
   * Run EVERY enabled matcher over the input and collect their verdicts. Disabled matchers are
   * skipped entirely (never invoked, never faked). Today this yields exactly the deterministic verdict.
   */
  runEnabled(input: MatcherInput): Array<{ matcher_id: string; verdict: ConfidenceVerdict }> {
    return this.enabled().map((m) => ({ matcher_id: m.id, verdict: m.match(input) }));
  }
}

/**
 * The canonical wiring: one ENABLED deterministic matcher + the four registered-DISABLED
 * strategies. This is the registry the stream-worker composition root should use.
 */
export function createDefaultMatcherRegistry(
  deterministic: DeterministicUnionFindMatcher = new DeterministicUnionFindMatcher(),
): MatcherRegistry {
  return new MatcherRegistry()
    .register(deterministic)
    .register(new ProbabilisticMatcher())
    .register(new MlMatcher())
    .register(new HouseholdMatcher())
    .register(new CrossDeviceMatcher());
}
