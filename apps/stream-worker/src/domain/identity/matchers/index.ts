/**
 * matchers/ — the identity Matcher registry + strategies (apps/stream-worker domain).
 *
 * The runtime side of the @brain/contracts Matcher port:
 *   - DeterministicUnionFindMatcher  — enabled; wraps IdentityResolver (strong-key merges); also
 *                                      the batch order-independent union-find for backfill.
 *   - ProbabilisticMatcher           — enabled; RULE-BASED, REVIEW-GATED Fellegi–Sunter over the
 *                                      WEAK signals. SUB-EXACT by construction → never auto-merges.
 *   - MlMatcher/HouseholdMatcher/CrossDeviceMatcher — registered-DISABLED
 *                                      (status='disabled-not-implemented'; match() throws NotImplementedYet).
 *   - MatcherRegistry                — holds them, iterates only ENABLED, rejects a disabled invoke.
 *
 * Pure domain. Deterministic-first (D-5); hash-only (I-S02); brand_id-first isolation.
 */
export {
  computeConnectedComponents,
  type IdentifierBrainEdge,
  type ConnectedComponent,
  type UnionFindResult,
} from './union-find.js';
export { DeterministicUnionFindMatcher } from './DeterministicUnionFindMatcher.js';
export {
  ProbabilisticMatcher,
  PROBABILISTIC_MATCHER_ID,
  PROBABILISTIC_RULE_VERSION,
  WEAK_SIGNAL_TYPES,
  DEFAULT_PROBABILISTIC_WEIGHTS,
  MAX_PROBABILISTIC_SCORE,
  type ProbabilisticWeights,
} from './ProbabilisticMatcher.js';
export {
  MlMatcher,
  HouseholdMatcher,
  CrossDeviceMatcher,
} from './DisabledMatchers.js';
export {
  MatcherRegistry,
  DuplicateMatcherError,
  UnknownMatcherError,
  createDefaultMatcherRegistry,
} from './MatcherRegistry.js';
