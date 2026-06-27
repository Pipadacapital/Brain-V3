/**
 * DisabledMatchers — the registered-but-DEFERRED matchers (D-5).
 *
 * Deterministic-first: ML / household / cross-device matching are ACKNOWLEDGED in the registry but
 * NOT implemented. Each is a `DisabledMatcher` (from @brain/contracts) with
 * `status = 'disabled-not-implemented'` whose `match()` throws `NotImplementedYet`. They are NEVER
 * faked: a disabled matcher does not return an empty verdict, a `true`, or a placeholder score —
 * "confidence before decisions" forbids fabricating a judgement. The only way to enable one is to
 * actually implement it and flip its status; until then invoking it is a loud, explicit error.
 *
 * NOTE: the probabilistic (Fellegi–Sunter) matcher is NO LONGER here — it has been implemented as a
 * real, rule-based, review-gated matcher (status='enabled') in ProbabilisticMatcher.ts. ML / household
 * / cross-device remain DISABLED.
 *
 * Pure domain. No IO. Each subclass pins its id / version / strategy; all merge behaviour
 * (the throw) is inherited from the contract's `DisabledMatcher` base.
 */
import { DisabledMatcher } from '@brain/contracts';

/**
 * Learned-embedding similarity over identity features. DEFERRED.
 * id/version mirror IDENTITY_MATCHER_REGISTRY's 'ml-embedding-similarity' descriptor.
 */
export class MlMatcher extends DisabledMatcher {
  constructor() {
    super('ml-embedding-similarity', 'v0', 'ml');
  }
}

/**
 * Household clustering (fuzzy graph linkage of distinct people sharing an address/payment
 * instrument). DEFERRED — household folding is explicitly out of scope for deterministic v1.
 * strategy='fuzzy' (graph/fuzzy linkage, distinct from the probabilistic record-linkage matcher).
 */
export class HouseholdMatcher extends DisabledMatcher {
  constructor() {
    super('household-clustering', 'v0', 'fuzzy');
  }
}

/**
 * Cross-device graph stitching (fuzzy linkage of device/anon identities across devices beyond the
 * deterministic resolve-only adoption the resolver already does). DEFERRED.
 * strategy='fuzzy' (probabilistic graph walk; never a deterministic merge key).
 */
export class CrossDeviceMatcher extends DisabledMatcher {
  constructor() {
    super('cross-device-graph', 'v0', 'fuzzy');
  }
}
