/**
 * IdentityStore — the store contract the identity resolver use-case depends on.
 *
 * MEDALLION REALIGNMENT (Epic 3 / ADR-0004): the Neo4jIdentityRepository (the SoR) satisfies this
 * contract, so ResolveIdentityUseCase is store-agnostic — the pure IdentityResolver runs unchanged.
 * (The legacy PG IdentityRepository was removed when the PG identity tables were dropped.)
 */
import type { ConfidenceVerdict } from '@brain/contracts';
import type {
  ExtractedIdentifier,
  ExistingLink,
  SharedUtilityState,
  BrandPhoneGuardConfig,
  ResolveOutcome,
  IdentityPriorityConfig,
} from './IdentityResolver.js';

export interface IdentityReadState {
  existingLinks: ExistingLink[];
  sharedUtilityMap: Map<string, SharedUtilityState>;
  phoneCount: Map<string, number>; // phone hash → windowed distinct brain_id count
  aliasChain: Set<string>;
  brandConfig: BrandPhoneGuardConfig;
  // SPEC: A.2.3.4 — brain_ids (among the brains the event's identifiers resolve to) that ALREADY own an
  // active STRONG identifier. Feeds the resolver's shared-device guard: a medium (anon/device) signal may
  // not pull a NEW strong id into a brain already owned by a DIFFERENT strong identity. OPTIONAL —
  // populated only by stores that support it; when absent the resolver guard is inert (byte-identical).
  strongOwnedBrainIds?: Set<string>;
}

/** A review-queue item (probabilistic weak-signal pair routed to human review — NEVER auto-merged). */
export interface ReviewQueueItem {
  /** Deterministic review_id (DecisionEngine) — idempotent enqueue on replay. */
  review_id: string;
  /** The candidate pair under review (hash-only context lives in `evidence`). */
  brain_id_a: string;
  brain_id_b: string;
  /** Why routed (e.g. 'probabilistic_match: weak-signal agreement'). */
  reason: string;
  /** Hash-only evidence (the ConfidenceVerdict's signals/combo). Never raw PII. */
  evidence: Record<string, unknown>;
}

export interface IdentityStore {
  readState(
    brandId: string,
    identifierHashes: Array<{ type: string; hash: string }>,
    now?: Date,
  ): Promise<IdentityReadState>;
  /**
   * Commit the deterministic resolution to the graph SoR. `verdict` (optional) is the structured
   * ConfidenceVerdict stamped on the committed IDENTIFIES / ALIAS_OF edges + MergeEvent node instead
   * of the hardcoded 100/exact; when omitted the adapter falls back to the deterministic exact stamp
   * (back-compat). DETERMINISTIC OUTCOMES ONLY ever reach here — a probabilistic verdict never does.
   */
  writeOutcome(
    brandId: string,
    outcome: ResolveOutcome,
    identifiers: ExtractedIdentifier[],
    verdict?: ConfidenceVerdict,
  ): Promise<{ written: boolean }>;
  /**
   * Fetch candidate customers that share any of the event's WEAK-signal hashes (the active
   * tier='weak' IDENTIFIES edges). Feeds ONLY the review-gated ProbabilisticMatcher — these edges
   * carry NO merge authority. Optional: a store without weak edges may omit it (the use-case guards).
   */
  findCandidatesByWeakSignals?(
    brandId: string,
    weakHashes: Array<{ type: string; hash: string }>,
  ): Promise<ExistingLink[]>;
  /**
   * Enqueue a probabilistic weak-signal pair to the human review queue (idempotent on review_id).
   * Optional: persistence of the route_to_review Command also goes to the Decision Log + Evidence
   * Store; this is the additional graph-side queue surface when the store provides one.
   */
  enqueueReview?(brandId: string, item: ReviewQueueItem): Promise<void>;
  /**
   * SPEC: A.1.5 (WA-12) — read the brand's CURRENT (highest-version) ordered identity priority config
   * from the versioned store (ops.brand_identity_priority). Returns null when the brand has never
   * customized its order (⇒ caller uses DEFAULT_IDENTITY_PRIORITY). Only consulted when the
   * `identity.priority_config` flag is ON. Optional: a store without the table may omit it.
   */
  readPriorityConfig?(brandId: string): Promise<IdentityPriorityConfig | null>;
}
