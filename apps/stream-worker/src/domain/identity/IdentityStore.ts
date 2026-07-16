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

/**
 * BATCH-BACKFILL read state (GAP-A batched path) — readState's shape over the UNION of a whole
 * batch's identifier hashes, plus the RAW phone-window brain sets the in-memory overlay needs.
 *
 * `phoneBrainIdsInWindow` carries, per phone hash, the DISTINCT brain_ids that have an ACTIVE
 * IDENTIFIES edge inside the suppression window — the SET behind readState's `phoneCount` count
 * (phoneCount[h] === phoneBrainIdsInWindow[h].size by construction). The batch overlay needs the
 * members, not just the count, so that linking phone h → brain B intra-batch increments the count
 * ONLY when B is a genuinely new distinct brain — exactly what a per-event re-read would observe.
 * NOTE these are the RAW edge-target brain_ids (NO alias resolution), mirroring readState's
 * windowed count query, which counts direct edge targets without following ALIAS_OF.
 */
export interface IdentityBatchReadState extends IdentityReadState {
  phoneBrainIdsInWindow: Map<string, Set<string>>;
}

/** One resolved event's write payload for the bulk writer (per-event writeOutcome's exact inputs). */
export interface BatchOutcomeItem {
  outcome: ResolveOutcome;
  identifiers: ExtractedIdentifier[];
  verdict?: ConfidenceVerdict;
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
   * BATCH BACKFILL (GAP-A batched path) — one bulk read covering the UNION of a whole batch's
   * identifier hashes: the same five sub-reads as readState (existing links w/ alias resolution,
   * strong-owned brains, shared-utility phone-guard rows, windowed phone counts, alias chain, brand
   * config) in ONE store round-trip, plus the raw phone-window brain SETS the overlay needs.
   * Returning the union is safe because the resolver only ever consults links whose (type, hash)
   * equal the CURRENT event's identifiers — a superset changes nothing. OPTIONAL: only bulk-capable
   * stores provide it; BatchResolveIdentityUseCase requires a store that does.
   */
  readStateBatch?(
    brandId: string,
    identifierHashes: Array<{ type: string; hash: string }>,
    now?: Date,
  ): Promise<IdentityBatchReadState>;
  /**
   * BATCH BACKFILL (GAP-A batched path) — apply a batch's resolve outcomes IN ORDER in one store
   * transaction. MUST be observably equivalent to calling writeOutcome(item) sequentially for each
   * item (same final graph: customers, links, merges/aliases, phone-guard rows, reviews, PG
   * audit/contact_pii rows) — timestamps excepted (one batch clock instead of one per event).
   * DETERMINISTIC outcomes only, exactly like writeOutcome. OPTIONAL: bulk-capable stores only.
   */
  writeOutcomesBatch?(brandId: string, items: BatchOutcomeItem[]): Promise<{ written: number }>;
  /**
   * SPEC: A.1.5 (WA-12) — read the brand's CURRENT (highest-version) ordered identity priority config
   * from the versioned store (ops.brand_identity_priority). Returns null when the brand has never
   * customized its order (⇒ caller uses DEFAULT_IDENTITY_PRIORITY). Only consulted when the
   * `identity.priority_config` flag is ON. Optional: a store without the table may omit it.
   */
  readPriorityConfig?(brandId: string): Promise<IdentityPriorityConfig | null>;
}
