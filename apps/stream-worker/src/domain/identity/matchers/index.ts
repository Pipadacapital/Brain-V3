/**
 * matchers/ — the identity Matcher registry + strategies (apps/stream-worker domain).
 *
 * The runtime side of the @brain/contracts Matcher port:
 *   - DeterministicUnionFindMatcher  — the ONE enabled matcher (wraps IdentityResolver); also
 *                                      the batch order-independent union-find for backfill.
 *   - ProbabilisticMatcher/MlMatcher/HouseholdMatcher/CrossDeviceMatcher — registered-DISABLED
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
