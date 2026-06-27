/**
 * InMemoryIdentityGraph — an in-process, isolated IdentityStore for OPERATOR REPLAY (read-side).
 *
 * The replay path (jobs/identity/replay-identity) rebuilds ONE brand's identity state from
 * Bronze/Silver via the SAME domain logic — it runs the EXISTING pure IdentityResolver over this
 * shadow store instead of the live Neo4jIdentityRepository. That makes a replay:
 *   - ISOLATED FROM LIVE  — it never opens a Neo4j/PG connection; the live graph is untouched.
 *   - PER-TENANT          — one instance holds exactly one brand's subgraph (brand_id-first).
 *   - IDEMPOTENT          — a pure function of the event stream; re-running yields the same graph.
 *   - FAITHFUL            — it satisfies the SAME IdentityStore contract the resolver consumes
 *                            (readState/writeOutcome), so the resolver's union-find / phone-guard /
 *                            cycle-guard behaviour is reproduced exactly, not re-implemented.
 *
 * HASH-ONLY (I-S02): only hashed identifier values are stored; contactPiiWrites are ignored (there
 * is no PII vault in a replay). NO MONEY. The graph carries `brand_id` on construction and rejects
 * any cross-brand write (defence-in-depth — a replay is single-tenant by construction).
 */
import type { IdentityReadState, IdentityStore } from './IdentityStore.js';
import type {
  ExtractedIdentifier,
  ExistingLink,
  SharedUtilityState,
  BrandPhoneGuardConfig,
  ResolveOutcome,
} from './IdentityResolver.js';
import type { IdentifierBrainEdge } from './matchers/union-find.js';

const STRONG_TIERS = new Set<ExtractedIdentifier['tier']>(['strong', 'strong_on_link']);

/** Default phone-guard config (mirrors the brand-table defaults: threshold 10, window 30d). */
export const DEFAULT_REPLAY_BRAND_CONFIG: BrandPhoneGuardConfig = {
  phone_guard_threshold: 10,
  suppression_window_days: 30,
};

/** An in-memory identity edge (one IDENTIFIES relationship). */
interface MemLink {
  brain_id: string;
  type: string;
  hash: string;
  tier: ExtractedIdentifier['tier'];
  is_active: boolean;
}

/** An in-memory customer node. */
interface MemCustomer {
  brain_id: string;
  lifecycle_state: 'active' | 'merged';
  merged_into: string | null;
}

export class InMemoryIdentityGraph implements IdentityStore {
  private readonly links: MemLink[] = [];
  private readonly customers = new Map<string, MemCustomer>();
  private readonly sharedUtility = new Map<string, SharedUtilityState>();
  private readonly reviews: Array<{ brain_id: string; reason: string }> = [];

  constructor(
    private readonly brandId: string,
    private readonly brandConfig: BrandPhoneGuardConfig = DEFAULT_REPLAY_BRAND_CONFIG,
  ) {}

  // ── IdentityStore contract ──────────────────────────────────────────────────

  async readState(
    brandId: string,
    identifierHashes: Array<{ type: string; hash: string }>,
    _now: Date = new Date(),
  ): Promise<IdentityReadState> {
    this.assertBrand(brandId);
    const wanted = new Set(identifierHashes.map((i) => `${i.type}:${i.hash}`));

    const existingLinks: ExistingLink[] = this.links
      .filter((l) => l.is_active && wanted.has(`${l.type}:${l.hash}`))
      .map((l) => ({
        brain_id: l.brain_id,
        identifier_type: l.type,
        identifier_value: l.hash,
        is_active: l.is_active,
      }));

    const phoneHashes = identifierHashes.filter((i) => i.type === 'phone').map((i) => i.hash);
    const sharedUtilityMap = new Map<string, SharedUtilityState>();
    const phoneCount = new Map<string, number>();
    for (const hash of phoneHashes) {
      const su = this.sharedUtility.get(hash);
      if (su) sharedUtilityMap.set(hash, { ...su });
      // Windowed distinct-brain_id count → in-memory: lifetime distinct active phone-link brain_ids.
      const distinct = new Set(
        this.links.filter((l) => l.is_active && l.type === 'phone' && l.hash === hash).map((l) => l.brain_id),
      );
      phoneCount.set(hash, distinct.size);
    }

    const aliasChain = new Set<string>();
    for (const c of this.customers.values()) {
      if (c.merged_into != null) aliasChain.add(c.brain_id);
    }

    return { existingLinks, sharedUtilityMap, phoneCount, aliasChain, brandConfig: this.brandConfig };
  }

  async writeOutcome(
    brandId: string,
    outcome: ResolveOutcome,
    _identifiers: ExtractedIdentifier[],
  ): Promise<{ written: boolean }> {
    this.assertBrand(brandId);

    // Customer node for the resolved brain_id.
    this.ensureCustomer(outcome.brainId);

    // New identifier edges (mint → all; link → the not-yet-linked ones; merge → none).
    for (const id of outcome.newLinks) {
      this.addLink(outcome.brainId, id.type, id.hash, id.tier);
    }

    // Merge: mark the merged customer + point it at the canonical survivor (the ALIAS_OF edge).
    if (outcome.action === 'merged' && outcome.merge) {
      const { canonicalBrainId, mergedBrainId } = outcome.merge;
      this.ensureCustomer(canonicalBrainId);
      const merged = this.ensureCustomer(mergedBrainId);
      merged.lifecycle_state = 'merged';
      merged.merged_into = canonicalBrainId;
    }

    // Phone-guard suppressions (keep the GREATEST profile_count).
    for (const u of outcome.phoneGuardUpdates) {
      if (!u.suppress) continue;
      const prev = this.sharedUtility.get(u.identifier_value);
      const profile_count = prev ? Math.max(prev.profile_count, u.profile_count) : u.profile_count;
      this.sharedUtility.set(u.identifier_value, {
        identifier_type: u.identifier_type,
        identifier_value: u.identifier_value,
        profile_count,
        suppressed_until: u.suppressed_until,
      });
    }

    if (outcome.routeToReview && outcome.reviewReason) {
      this.reviews.push({ brain_id: outcome.brainId, reason: outcome.reviewReason });
    }

    return { written: true };
  }

  // ── Replay inspection (order-independence + determinism cross-checks) ────────

  /** All ACTIVE STRONG identifier→brain_id edges — the merge-key set the union-find unions over. */
  activeStrongEdges(): IdentifierBrainEdge[] {
    return this.links
      .filter((l) => l.is_active && STRONG_TIERS.has(l.tier))
      .map((l) => ({ identifier_key: `${l.type}:${l.hash}`, brain_id: l.brain_id }));
  }

  /**
   * The order/label-INDEPENDENT partition signature of the STREAMING replay: group every active
   * strong identifier_key by the ROOT customer it resolves to (follow merged_into), drop the brain_id
   * labels (they are random per mint), sort. Two replays over different event orders — or with
   * different randomly-minted brain_ids — produce the SAME signature iff they produce the same graph.
   */
  streamStrongPartitionSignature(): string {
    const groups = new Map<string, Set<string>>();
    for (const edge of this.activeStrongEdges()) {
      const root = this.rootOf(edge.brain_id);
      let set = groups.get(root);
      if (!set) {
        set = new Set<string>();
        groups.set(root, set);
      }
      set.add(edge.identifier_key);
    }
    return partitionSignature(groups);
  }

  /** Count of distinct resolved (root) identities — for the replay report. */
  distinctIdentities(): number {
    const roots = new Set<string>();
    for (const c of this.customers.values()) roots.add(this.rootOf(c.brain_id));
    return roots.size;
  }

  reviewCount(): number {
    return this.reviews.length;
  }

  /** Follow the merged_into alias chain to the canonical root (cycle-guarded). */
  rootOf(brainId: string): string {
    const seen = new Set<string>();
    let cur = brainId;
    while (true) {
      if (seen.has(cur)) return cur; // defensive: never loop (the resolver's cycle-guard prevents this)
      seen.add(cur);
      const c = this.customers.get(cur);
      if (!c || c.merged_into == null) return cur;
      cur = c.merged_into;
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private ensureCustomer(brainId: string): MemCustomer {
    let c = this.customers.get(brainId);
    if (!c) {
      c = { brain_id: brainId, lifecycle_state: 'active', merged_into: null };
      this.customers.set(brainId, c);
    }
    return c;
  }

  private addLink(brainId: string, type: string, hash: string, tier: ExtractedIdentifier['tier']): void {
    const existing = this.links.find((l) => l.brain_id === brainId && l.type === type && l.hash === hash);
    if (existing) {
      existing.is_active = true;
      return;
    }
    this.links.push({ brain_id: brainId, type, hash, tier, is_active: true });
  }

  private assertBrand(brandId: string): void {
    if (brandId !== this.brandId) {
      throw new Error(
        `[InMemoryIdentityGraph] cross-brand access rejected: graph is brand=${this.brandId}, got ${brandId}`,
      );
    }
  }
}

/**
 * Build the order/label-independent signature of a partition: each group's members sorted, then the
 * groups sorted, then JSON-encoded. Pure — used by both the streaming and batch determinism checks.
 */
export function partitionSignature(groups: Map<string, Set<string>>): string {
  const arrays = [...groups.values()].map((s) => [...s].sort());
  arrays.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return JSON.stringify(arrays);
}
