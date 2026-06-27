/**
 * identity/ — the identity DOMAIN contract cluster (Zod-as-source-of-truth).
 *
 * Distinct from api/identity.api.v1.ts (the BFF READ DTOs, Customer 360). This cluster is the
 * domain vocabulary the resolver/matcher/graph-repository operate on:
 *   - identifier.ts          — the hash-only, tenant-scoped Identifier value object + vocabulary
 *   - confidence-verdict.ts  — ConfidenceVerdict (integer 0-100, never money)
 *   - decision.ts            — the reversible IdentityDecision command union (+ compensations)
 *   - matcher.ts             — the Matcher port + registry (deferred strategies registered-DISABLED)
 *   - repository.ts          — the IdentityGraphRepository (Neo4j SoR) port
 *
 * INVARIANTS: hash-only PII (I-S02), brand_id-first tenant isolation, confidence is an integer
 * (never blended with money), deferred matchers are registered-DISABLED (never faked).
 */

// ── Identifier value object + vocabulary ──────────────────────────────────────
export {
  IDENTITY_RULE_VERSION,
  IdentifierTypeSchema,
  IdentifierTierSchema,
  IdentifierHashSchema,
  IdentifierSchema,
} from './identifier.js';
export type {
  IdentifierType,
  IdentifierTier,
  IdentifierHash,
  Identifier,
} from './identifier.js';

// ── ConfidenceVerdict ─────────────────────────────────────────────────────────
export {
  ConfidenceBandSchema,
  IdentifierComboMemberSchema,
  ConfidenceVerdictSchema,
} from './confidence-verdict.js';
export type {
  ConfidenceBand,
  IdentifierComboMember,
  ConfidenceVerdict,
} from './confidence-verdict.js';

// ── IdentityDecision (reversible command union) ───────────────────────────────
export {
  CompensationKindSchema,
  CompensationSchema,
  MintDecisionSchema,
  LinkDecisionSchema,
  MergeDecisionSchema,
  UnmergeDecisionSchema,
  SuppressDecisionSchema,
  RouteToReviewDecisionSchema,
  IdentityDecisionSchema,
  IdentityCommandSchema,
} from './decision.js';
export type {
  CompensationKind,
  Compensation,
  MintDecision,
  LinkDecision,
  MergeDecision,
  UnmergeDecision,
  SuppressDecision,
  RouteToReviewDecision,
  IdentityDecision,
  IdentityCommand,
} from './decision.js';

// ── Matcher port + registry ───────────────────────────────────────────────────
export {
  MatcherStatusSchema,
  MatcherStrategySchema,
  MatcherDescriptorSchema,
  NotImplementedYet,
  DisabledMatcher,
  IDENTITY_MATCHER_REGISTRY,
} from './matcher.js';
export type {
  MatcherStatus,
  MatcherStrategy,
  MatcherInput,
  Matcher,
  MatcherDescriptor,
} from './matcher.js';

// ── IdentityGraphRepository port (Neo4j SoR) ──────────────────────────────────
export type {
  IdentityGraphReadState,
  IdentityDecisionReceipt,
  IdentityGraphRepository,
} from './repository.js';
