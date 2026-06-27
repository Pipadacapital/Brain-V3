/**
 * DeterministicUnionFindMatcher — the ONE enabled Matcher (D-5).
 *
 * WRAPS the existing pure-domain IdentityResolver behind the `Matcher` port (@brain/contracts):
 *   - `id`      = 'deterministic-union-find'  (mirrors IDENTITY_MATCHER_REGISTRY)
 *   - `version` = RULE_VERSION                (lock-step with IdentityResolver.RULE_VERSION)
 *   - `status`  = 'enabled'                   (the only live matcher; the rest are DISABLED)
 *
 * Two responsibilities, ONE deterministic rule:
 *   (a) match()         — the STREAM judgement: does any STRONG (merge-key) identifier on the
 *                         event exactly match a candidate already in the graph? Strong overlap →
 *                         a deterministic-certainty verdict (score 100, band 'exact'). Otherwise
 *                         score 0, band 'none' (mint a fresh identity). It NEVER fabricates a
 *                         sub-100 probabilistic score — that is the deferred matchers' (disabled) job.
 *   (b) batchUnionFind / batchResolve — the BACKFILL judgement: order-independent connected
 *                         components over `identifier → brain_id` edges, canonical = lowest UUID.
 *                         batchResolve reuses the WRAPPED resolver's `computeMergeId` (D-4) so the
 *                         backfill emits the SAME deterministic merge_ids as the stream → identical graph.
 *
 * Pure domain: imports only @brain/contracts (types) + the sibling IdentityResolver/union-find
 * (domain). No Neo4j, no Kafka. Hash-only (I-S02). brand_id-first tenant isolation on every path.
 * Confidence is an INTEGER 0–100 — never blended with money.
 */
import type {
  Matcher,
  MatcherInput,
  ConfidenceVerdict,
  IdentifierComboMember,
  Identifier,
} from '@brain/contracts';
import { IdentityResolver, RULE_VERSION, type MergeSpec } from '../IdentityResolver.js';
import {
  computeConnectedComponents,
  type IdentifierBrainEdge,
  type UnionFindResult,
} from './union-find.js';

/** Strong tiers are the ONLY merge keys (mirrors IdentityResolver §3). */
function isStrongTier(tier: Identifier['tier']): boolean {
  return tier === 'strong' || tier === 'strong_on_link';
}

/** The hash-only composite key used for exact equality (I-S02). */
function keyOf(id: { identifier_type: string; identifier_hash: string }): string {
  return `${id.identifier_type}:${id.identifier_hash}`;
}

export class DeterministicUnionFindMatcher implements Matcher {
  readonly id = 'deterministic-union-find';
  readonly version = RULE_VERSION;
  readonly status = 'enabled' as const;

  /**
   * Wraps the pure IdentityResolver. Injected for testability; defaults to a fresh instance.
   * The resolver supplies the canonical-merge rule + deterministic merge_id (D-4) the batch path reuses.
   */
  constructor(private readonly resolver: IdentityResolver = new IdentityResolver()) {}

  /**
   * STREAM judgement. Exact salted-hash overlap on a STRONG identifier → deterministic certainty.
   *
   * @returns score 100 / band 'exact' when ≥1 strong identifier matches a candidate; otherwise
   *          score 0 / band 'none'. Verdict is hash-only and brand-scoped.
   */
  match(input: MatcherInput): ConfidenceVerdict {
    const { brand_id, identifiers, candidates = [] } = input;

    // ── Tenant isolation (brand_id-first): never match across brands. Per-brand salting already
    //    makes cross-brand hashes non-colliding; this is defense-in-depth on the matcher seam.
    const brandIdentifiers = identifiers.filter((i) => i.brand_id === brand_id);
    const brandCandidates = candidates.filter((c) => c.brand_id === brand_id);

    // ── Strong keys only — the deterministic union-find merges exclusively on strong identifiers.
    const strong = brandIdentifiers.filter((i) => isStrongTier(i.tier));
    const candidateKeys = new Set(brandCandidates.map(keyOf));
    const matched = strong.filter((i) => candidateKeys.has(keyOf(i)));

    if (matched.length > 0) {
      const combo: IdentifierComboMember[] = matched.map((m) => ({
        identifier_type: m.identifier_type,
        identifier_hash: m.identifier_hash,
      }));
      // Dedupe reason codes (two emails → one 'strong_key:email' reason); combo keeps all members.
      const reasons = [...new Set(matched.map((m) => `strong_key:${m.identifier_type}`))];
      return {
        score: 100,
        band: 'exact',
        reasons,
        matcher_id: this.id,
        rule_version: this.version,
        identifier_combo: combo,
      };
    }

    // No strong overlap → no deterministic evidence. score 0 / band 'none' (mint a fresh identity).
    return {
      score: 0,
      band: 'none',
      reasons: strong.length === 0 ? ['no_strong_identifier'] : ['no_strong_match'],
      matcher_id: this.id,
      rule_version: this.version,
      identifier_combo: [],
    };
  }

  /**
   * BACKFILL judgement (pure). Order-independent connected components over identifier→brain_id
   * edges. Canonical = lowest UUID — the SAME rule the stream resolver applies, so shuffling the
   * batch (or replaying it) yields the identical graph the stream would have built event-by-event.
   */
  batchUnionFind(edges: IdentifierBrainEdge[]): UnionFindResult {
    return computeConnectedComponents(edges);
  }

  /**
   * BACKFILL → merge specs. For every non-canonical member of every component, emit a deterministic
   * MergeSpec whose `mergeId` is computed by the WRAPPED resolver (`computeMergeId`, D-4) — byte-for-byte
   * the same merge_id the stream would assign for the same (canonical, merged) pair. Idempotent on
   * replay (same inputs → same merge_id → ON CONFLICT no-op).
   *
   * @param brandId  the brand the edges belong to (drives the deterministic merge_id, D-4).
   * @param edges    identifier→brain_id edges for that brand (hash-only).
   * @returns        the components + the flattened, order-independent list of MergeSpecs.
   */
  batchResolve(
    brandId: string,
    edges: IdentifierBrainEdge[],
  ): { components: UnionFindResult['components']; merges: MergeSpec[] } {
    const { components } = this.batchUnionFind(edges);
    const merges: MergeSpec[] = [];
    for (const { canonical, members } of components) {
      for (const merged of members) {
        if (merged === canonical) continue;
        merges.push({
          canonicalBrainId: canonical,
          mergedBrainId: merged,
          mergeId: this.resolver.computeMergeId(brandId, canonical, merged),
        });
      }
    }
    return { components, merges };
  }
}
