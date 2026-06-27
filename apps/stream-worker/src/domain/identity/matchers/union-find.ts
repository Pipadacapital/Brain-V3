/**
 * union-find.ts — the batch, order-independent connected-components helper for the
 * deterministic identity matcher.
 *
 * WHY: the streaming resolver (IdentityResolver.resolve) folds brain_ids together one event
 * at a time — each merge takes the LOWEST-sorted UUID as canonical (D-4). A backfill /
 * reconciliation job, however, sees a whole batch of `identifier → brain_id` edges at once.
 * To guarantee the BACKFILL PRODUCES THE SAME GRAPH AS THE STREAM, the batch path must:
 *   1. compute the SAME connected components regardless of the order edges arrive in, and
 *   2. pick the SAME canonical survivor (lexicographically lowest brain_id) per component.
 *
 * This module is the pure disjoint-set (union-find) primitive behind that guarantee. It is
 * IO-free domain logic (no Neo4j, no Kafka). Hash-only (I-S02): an edge's `identifier_key`
 * is `${identifier_type}:${identifier_hash}` — never raw PII. brand_id-scoping is the caller's
 * responsibility (feed it one brand's edges; cross-brand hashes can never collide anyway because
 * the salt namespace differs).
 *
 * ORDER-INDEPENDENCE PROOF SKETCH:
 *   - Edges are grouped by `identifier_key` into SETS of brain_ids — set membership is
 *     order-independent.
 *   - The union of a set of nodes yields the SAME partition no matter the union order
 *     (connected-components is an equivalence relation; order cannot change the equivalence classes).
 *   - The canonical survivor is recomputed as `min(member brain_ids)` AFTER all unions, and the
 *     members are sorted — both are functions of the final SET, independent of insertion order.
 * Therefore shuffling the input edges yields byte-identical components + canonical assignments.
 */

/**
 * One `identifier → brain_id` edge. `identifier_key` is the hash-only composite key
 * `${identifier_type}:${identifier_hash}` (I-S02) so two brain_ids that share the SAME strong
 * identifier get unioned. brand-scoped by the caller.
 */
export interface IdentifierBrainEdge {
  /** Hash-only composite identifier key: `${identifier_type}:${identifier_hash}` (never raw PII). */
  identifier_key: string;
  /** The brain_id this identifier is currently linked to. */
  brain_id: string;
}

/** A resolved connected component: its canonical survivor + all member brain_ids (sorted). */
export interface ConnectedComponent {
  /**
   * Canonical survivor = the lexicographically LOWEST brain_id in the component. This is the
   * SAME rule the streaming resolver uses (IdentityResolver.resolve: `sortedIds[0]`), so stream
   * and backfill agree on which brain_id survives a merge.
   */
  canonical: string;
  /** Every brain_id in the component, sorted ascending (order-independent). */
  members: string[];
}

/** The result of a batch union-find pass. */
export interface UnionFindResult {
  /** Components sorted by `canonical` (deterministic output order). */
  components: ConnectedComponent[];
  /** brain_id → its canonical survivor (the brain_id it folds into). Identity for singletons. */
  canonicalOf: Map<string, string>;
}

/**
 * Compute order-independent connected components over `identifier → brain_id` edges.
 *
 * Two brain_ids are in the same component iff they are connected through a chain of shared
 * identifiers. The canonical survivor of each component is the lexicographically lowest brain_id.
 *
 * Pure + deterministic: shuffling `edges` yields an identical result (see the proof sketch above).
 *
 * @param edges  `identifier_key → brain_id` edges (hash-only, single-brand).
 * @returns      components (sorted by canonical) + a brain_id→canonical map.
 */
export function computeConnectedComponents(edges: IdentifierBrainEdge[]): UnionFindResult {
  // ── Disjoint-set over brain_ids ────────────────────────────────────────────
  // parent maps a brain_id to its DSU parent; a node missing from the map is its own root.
  const parent = new Map<string, string>();

  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    if (root === x) return x;
    // Path-compression with iterative root walk (no recursion → no stack blowup on long chains).
    const chain: string[] = [x];
    while (true) {
      const p = parent.get(root) ?? root;
      if (p === root) break;
      chain.push(root);
      root = p;
    }
    for (const node of chain) parent.set(node, root);
    return root;
  };

  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Attach the higher root onto the lower (lexicographic) so the root is itself deterministic.
    // (Canonical is recomputed as min-member regardless, but a stable root keeps find() output
    // order-independent too.)
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  // ── 1. Group brain_ids by shared identifier_key (set membership = order-independent) ──
  const byIdentifier = new Map<string, Set<string>>();
  const allBrainIds = new Set<string>();
  for (const { identifier_key, brain_id } of edges) {
    allBrainIds.add(brain_id);
    let group = byIdentifier.get(identifier_key);
    if (!group) {
      group = new Set<string>();
      byIdentifier.set(identifier_key, group);
    }
    group.add(brain_id);
  }

  // ── 2. Union every brain_id that shares an identifier ────────────────────────
  // Sort each group so the union sequence itself is order-independent (belt-and-braces; the
  // final partition is union-order-invariant regardless).
  for (const group of byIdentifier.values()) {
    const sorted = [...group].sort();
    for (let i = 1; i < sorted.length; i++) union(sorted[0]!, sorted[i]!);
  }

  // ── 3. Bucket brain_ids by their final root ──────────────────────────────────
  const buckets = new Map<string, string[]>();
  for (const brainId of allBrainIds) {
    const root = find(brainId);
    let bucket = buckets.get(root);
    if (!bucket) {
      bucket = [];
      buckets.set(root, bucket);
    }
    bucket.push(brainId);
  }

  // ── 4. Canonical = lowest member; sort members + components for deterministic output ──
  const canonicalOf = new Map<string, string>();
  const components: ConnectedComponent[] = [];
  for (const members of buckets.values()) {
    const sortedMembers = [...members].sort();
    const canonical = sortedMembers[0]!;
    for (const m of sortedMembers) canonicalOf.set(m, canonical);
    components.push({ canonical, members: sortedMembers });
  }
  components.sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0));

  return { components, canonicalOf };
}
