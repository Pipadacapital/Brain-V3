/**
 * IdentityReplayEngine — deterministic, isolated rebuild of one brand's identity graph (read-side).
 *
 * The replay reuses the SAME domain logic as the live stream — it does NOT re-implement matching:
 *   1. STREAM path  — runs the EXISTING pure `IdentityResolver` (union-find / phone-guard /
 *      cycle-guard) over an in-memory `InMemoryIdentityGraph` (the isolated shadow store), event by
 *      event, exactly as the live consumer does. This is the system-of-record rebuild.
 *   2. BATCH cross-check — independently recomputes the partition with the order-independent
 *      `computeConnectedComponents` backfill union-find (matchers/union-find) over the SAME active
 *      strong edges, and asserts STREAM == BATCH. That equality is the order-independence guarantee:
 *      the merge partition is a function of which identifiers co-occur, never of event order.
 *
 * Determinism is checked on the LABEL-FREE partition signature (groups of identifier_keys), because
 * brain_ids are minted with randomUUID — the LABELS differ across replays, but the PARTITION (which
 * identifiers belong to the same person) must be identical. The engine permutes the event order and
 * asserts the signature is stable.
 *
 * Pure + IO-free: no Neo4j, no PG, no Kafka. Per-tenant (one brand per run). Idempotent: a pure
 * function of the event stream. Hash-only (I-S02). @effort("deterministic").
 */
import { IdentityResolver } from './IdentityResolver.js';
import type { ExtractedIdentifier, ResolveAction, BrandPhoneGuardConfig } from './IdentityResolver.js';
import { InMemoryIdentityGraph, DEFAULT_REPLAY_BRAND_CONFIG, partitionSignature } from './InMemoryIdentityGraph.js';
import { computeConnectedComponents, type IdentifierBrainEdge } from './matchers/union-find.js';

const STRONG_TIERS = new Set<ExtractedIdentifier['tier']>(['strong', 'strong_on_link']);

/** One replayed Bronze event: its already-extracted, already-hashed identifiers (hash-only). */
export interface ReplayEvent {
  /** Source Bronze event_id (for deterministic permutation ordering + the report). */
  event_id?: string;
  identifiers: ExtractedIdentifier[];
}

export interface ReplayOptions {
  brandId: string;
  brandConfig?: BrandPhoneGuardConfig;
  /** Fixed clock for determinism (phone-guard windows). Defaults to a stable instant. */
  now?: Date;
}

export interface ReplayResult {
  brandId: string;
  eventsProcessed: number;
  outcomes: ResolveAction[];
  /** Distinct resolved (root) identities after the rebuild. */
  distinctIdentities: number;
  reviewCount: number;
  /** Label-free partition signature from the STREAM rebuild (IdentityResolver). */
  streamSignature: string;
  /** Label-free partition signature from the BATCH union-find (computeConnectedComponents). */
  batchSignature: string;
  /** True iff the streaming rebuild and the batch union-find agree (the core invariant). */
  streamEqualsBatch: boolean;
  graph: InMemoryIdentityGraph;
}

const STABLE_NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * Replay a brand's events through the resolver into a fresh isolated graph, and cross-check the
 * resulting partition against the order-independent batch union-find.
 */
export async function replayIdentity(events: ReplayEvent[], opts: ReplayOptions): Promise<ReplayResult> {
  const now = opts.now ?? STABLE_NOW;
  const graph = new InMemoryIdentityGraph(opts.brandId, opts.brandConfig ?? DEFAULT_REPLAY_BRAND_CONFIG);
  const resolver = new IdentityResolver();
  const outcomes: ResolveAction[] = [];

  for (const ev of events) {
    const idHashes = ev.identifiers.map((i) => ({ type: i.type, hash: i.hash }));
    const state = await graph.readState(opts.brandId, idHashes, now);
    const outcome = resolver.resolve(
      opts.brandId,
      ev.identifiers,
      state.existingLinks,
      state.sharedUtilityMap,
      state.phoneCount,
      state.brandConfig,
      state.aliasChain,
      now,
    );
    await graph.writeOutcome(opts.brandId, outcome, ev.identifiers);
    outcomes.push(outcome.action);
  }

  const streamSignature = graph.streamStrongPartitionSignature();
  const batchSignature = batchStrongSignature(events);

  return {
    brandId: opts.brandId,
    eventsProcessed: events.length,
    outcomes,
    distinctIdentities: graph.distinctIdentities(),
    reviewCount: graph.reviewCount(),
    streamSignature,
    batchSignature,
    streamEqualsBatch: streamSignature === batchSignature,
    graph,
  };
}

/**
 * The label-free partition signature from the BATCH union-find — the order-INDEPENDENT ground truth.
 *
 * The merge partition is determined by which STRONG identifiers CO-OCCUR in an event (a single event
 * carrying two strong identifiers is exactly what makes the resolver merge their two profiles). This
 * reuses the EXISTING `computeConnectedComponents` backfill union-find with the roles swapped: each
 * event is the shared key, each strong identifier_key is a node — so the union-find groups identifier
 * keys that ever appeared together (transitively). That partition is a pure function of the event
 * multiset (never of order), and MUST equal the streaming resolver's `merged_into` partition.
 */
function batchStrongSignature(events: ReplayEvent[]): string {
  // (event_key → identifier_key) edges: computeConnectedComponents unions identifier_keys that share
  // an event_key (i.e. co-occurred), exactly mirroring why the resolver merges co-present identities.
  const edges: IdentifierBrainEdge[] = [];
  let i = 0;
  for (const ev of events) {
    const eventKey = ev.event_id ?? `__ev_${i}`;
    for (const id of ev.identifiers) {
      if (!STRONG_TIERS.has(id.tier)) continue;
      edges.push({ identifier_key: eventKey, brain_id: `${id.type}:${id.hash}` });
    }
    i += 1;
  }

  const { canonicalOf } = computeConnectedComponents(edges);
  const groups = new Map<string, Set<string>>();
  for (const edge of edges) {
    const idKey = edge.brain_id; // the swapped role: brain_id slot holds the identifier_key
    const canonical = canonicalOf.get(idKey) ?? idKey;
    let set = groups.get(canonical);
    if (!set) {
      set = new Set<string>();
      groups.set(canonical, set);
    }
    set.add(idKey);
  }
  return partitionSignature(groups);
}

export interface OrderIndependenceReport {
  /** True iff every permutation produced the SAME stream partition signature. */
  orderIndependent: boolean;
  /** True iff every permutation's stream signature also equalled its batch signature. */
  streamEqualsBatch: boolean;
  /** The (deduped) set of stream signatures observed — size 1 ⇒ order-independent. */
  signatures: string[];
  /** Per-permutation results (for the operator report). */
  runs: Array<{ label: string; streamSignature: string; batchSignature: string; outcomes: ResolveAction[] }>;
}

/**
 * Prove the rebuild is order-independent: replay the events in several deterministic orderings
 * (as-given, reversed, sorted-by-event-id) and assert the partition signature is identical across
 * all of them AND equal to the batch union-find each time. This is the determinism assertion the
 * operator replay job runs (and the unit test pins).
 */
export async function assertOrderIndependent(
  events: ReplayEvent[],
  opts: ReplayOptions,
): Promise<OrderIndependenceReport> {
  const orderings: Array<{ label: string; events: ReplayEvent[] }> = [
    { label: 'as-given', events },
    { label: 'reversed', events: [...events].reverse() },
    { label: 'sorted-by-event-id', events: sortByEventId(events) },
  ];

  const runs: OrderIndependenceReport['runs'] = [];
  const sigSet = new Set<string>();
  let streamEqualsBatch = true;

  for (const ordering of orderings) {
    const r = await replayIdentity(ordering.events, opts);
    runs.push({
      label: ordering.label,
      streamSignature: r.streamSignature,
      batchSignature: r.batchSignature,
      outcomes: r.outcomes,
    });
    sigSet.add(r.streamSignature);
    if (!r.streamEqualsBatch) streamEqualsBatch = false;
  }

  return {
    orderIndependent: sigSet.size === 1,
    streamEqualsBatch,
    signatures: [...sigSet],
    runs,
  };
}

/** Deterministic permutation by event_id (stable, never throws on missing ids). */
function sortByEventId(events: ReplayEvent[]): ReplayEvent[] {
  return [...events].sort((a, b) => {
    const ka = a.event_id ?? '';
    const kb = b.event_id ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
