/**
 * stream-backfill-resolution-parity.test.ts — ORDER-INDEPENDENCE at the RESOLUTION level,
 * framed explicitly as LIVE-lane order vs BACKFILL-lane order parity.
 *
 * WHY (and how this differs from the existing proofs):
 *   - matchers/union-find.test.ts proves `computeConnectedComponents` is invariant under a *random*
 *     shuffle of edges (a generic order-independence property of the primitive).
 *   - identity-replay-determinism.test.ts proves the streaming `IdentityResolver` rebuild equals the
 *     batch union-find via the IdentityReplayEngine (stream == batch on a label-free signature).
 *   - THIS test pins the operational invariant that matters for the two real ingest lanes: the SAME
 *     `identifier → brain_id` edge set, observed in the order the LIVE stream would fold it (event by
 *     event, chronologically) vs the order a BACKFILL / reconciliation job would scan it (table scan
 *     grouped/sorted differently), resolves — through the ONE enabled matcher
 *     `DeterministicUnionFindMatcher` (D-5) — to a BYTE-IDENTICAL result:
 *        • the canonical brain_id assignment per component (lowest-UUID survivor, D-4),
 *        • the merge SET of every component, AND
 *        • the deterministic merge_ids (D-4: sha256(brand ‖ canonical ‖ merged ‖ rule_version)).
 *
 * If the live lane and the backfill lane could ever disagree on which brain_id survives or which
 * profiles fold together, attribution / revenue truth would diverge between real-time and replay.
 * This test is the guardrail for that.
 *
 * Pure domain: no Neo4j, no Kafka, no StarRocks, no Postgres. Hash-only edges. brand_id-scoped.
 */
import { describe, it, expect } from 'vitest';
import { DeterministicUnionFindMatcher } from '../domain/identity/matchers/DeterministicUnionFindMatcher.js';
import {
  computeConnectedComponents,
  type IdentifierBrainEdge,
} from '../domain/identity/matchers/union-find.js';

// ── Fixtures: stable, lexicographically-sortable brain_ids (lowest == canonical survivor) ──
const BRAND = '11111111-1111-4111-8111-111111111111';
const BA = '00000000-0000-4000-8000-00000000000a';
const BB = '00000000-0000-4000-8000-00000000000b';
const BC = '00000000-0000-4000-8000-00000000000c';
const BD = '00000000-0000-4000-8000-00000000000d';
const BE = '00000000-0000-4000-8000-00000000000e';
const BF = '00000000-0000-4000-8000-00000000000f';

/** A hash-only composite identifier key `${type}:${64-hex}` (I-S02 — never raw PII). */
const k = (type: string, n: number) => `${type}:${String(n).padStart(64, '0')}`;
const EMAIL_1 = k('email', 1); // bridges BA–BB
const PHONE_2 = k('phone', 2); // bridges BB–BC  (⇒ BA–BB–BC is one component)
const EMAIL_3 = k('email', 3); // bridges BD–BE
const EMAIL_4 = k('email', 4); // BF only (singleton component)

/**
 * The canonical edge SET (a multiset of identity_link rows). Both lanes resolve THIS exact set;
 * only the arrival/scan ORDER differs between lanes.
 *
 * Expected partition: { BA,BB,BC } (canon BA) · { BD,BE } (canon BD) · { BF } (canon BF).
 */
const EDGE_SET: IdentifierBrainEdge[] = [
  { identifier_key: EMAIL_1, brain_id: BA },
  { identifier_key: EMAIL_1, brain_id: BB },
  { identifier_key: PHONE_2, brain_id: BB },
  { identifier_key: PHONE_2, brain_id: BC },
  { identifier_key: EMAIL_3, brain_id: BD },
  { identifier_key: EMAIL_3, brain_id: BE },
  { identifier_key: EMAIL_4, brain_id: BF },
];

/**
 * LIVE-lane order — the order the streaming resolver folds edges as events arrive chronologically
 * (one identifier observation at a time). This is just EDGE_SET as authored.
 */
const LIVE_ORDER: IdentifierBrainEdge[] = [...EDGE_SET];

/**
 * BACKFILL-lane order — a reconciliation job scans the identity_link table grouped by brain_id and
 * (here) descending, then by identifier — a deliberately DIFFERENT traversal than the live lane.
 */
const BACKFILL_ORDER: IdentifierBrainEdge[] = [...EDGE_SET].sort((x, y) => {
  if (x.brain_id !== y.brain_id) return x.brain_id < y.brain_id ? 1 : -1; // brain_id DESC
  return x.identifier_key < y.identifier_key ? -1 : x.identifier_key > y.identifier_key ? 1 : 0;
});

/** Deterministic Fisher–Yates (seeded LCG) — reproducible "any scan order" backfill permutations. */
function shuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed >>> 0;
  const rand = () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('stream==backfill resolution parity (DeterministicUnionFindMatcher, D-5)', () => {
  it('sanity: the live lane resolves the expected partition + lowest-UUID canonicals', () => {
    const matcher = new DeterministicUnionFindMatcher();
    const { components } = matcher.batchResolve(BRAND, LIVE_ORDER);
    expect(components).toEqual([
      { canonical: BA, members: [BA, BB, BC] }, // BA bridges to BB (email) → BC (phone)
      { canonical: BD, members: [BD, BE] },
      { canonical: BF, members: [BF] },
    ]);
  });

  it('canonical assignment + merge SET are BYTE-IDENTICAL across live vs backfill order', () => {
    const matcher = new DeterministicUnionFindMatcher();
    const live = matcher.batchResolve(BRAND, LIVE_ORDER);
    const backfill = matcher.batchResolve(BRAND, BACKFILL_ORDER);

    // BYTE-IDENTICAL: serialise both results and compare the strings (canonical + members + merge_ids).
    expect(JSON.stringify(backfill)).toBe(JSON.stringify(live));
    // The two orderings are genuinely different (otherwise the proof is vacuous).
    expect(JSON.stringify(BACKFILL_ORDER)).not.toBe(JSON.stringify(LIVE_ORDER));
  });

  it('the deterministic merge_ids (D-4) are byte-identical across lanes', () => {
    const matcher = new DeterministicUnionFindMatcher();
    const live = matcher.batchResolve(BRAND, LIVE_ORDER).merges;
    const backfill = matcher.batchResolve(BRAND, BACKFILL_ORDER).merges;

    // Component {BA,BB,BC} yields merges BA<-BB and BA<-BC; {BD,BE} yields BD<-BE; {BF} yields none.
    expect(live.map((m) => [m.canonicalBrainId, m.mergedBrainId])).toEqual([
      [BA, BB],
      [BA, BC],
      [BD, BE],
    ]);
    // Every merge_id is a real, deterministic UUID (not empty).
    for (const m of live) {
      expect(m.mergeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    // Lane parity on the FULL merge spec (canonical, merged, AND merge_id).
    expect(backfill).toEqual(live);
  });

  it('canonicalOf map is identical across many backfill scan orders (any traversal → same survivor)', () => {
    const matcher = new DeterministicUnionFindMatcher();
    const liveCanon = matcher.batchUnionFind(LIVE_ORDER).canonicalOf;
    const liveSorted = [...liveCanon.entries()].sort();

    // reversed, brain_id-desc, and 50 seeded shuffles — every plausible backfill scan order.
    const orders: IdentifierBrainEdge[][] = [
      [...EDGE_SET].reverse(),
      BACKFILL_ORDER,
      ...Array.from({ length: 50 }, (_, i) => shuffle(EDGE_SET, i + 1)),
    ];
    for (const order of orders) {
      const canon = matcher.batchUnionFind(order).canonicalOf;
      expect([...canon.entries()].sort()).toEqual(liveSorted);
    }
    // Every brain_id maps to its component's lowest UUID.
    expect(liveCanon.get(BB)).toBe(BA);
    expect(liveCanon.get(BC)).toBe(BA);
    expect(liveCanon.get(BE)).toBe(BD);
    expect(liveCanon.get(BF)).toBe(BF);
  });

  it('matches the raw computeConnectedComponents primitive (the matcher adds no order sensitivity)', () => {
    const matcher = new DeterministicUnionFindMatcher();
    // The matcher wraps the pure primitive; both must agree on the components for either lane order.
    const viaMatcher = matcher.batchUnionFind(BACKFILL_ORDER).components;
    const viaPrimitive = computeConnectedComponents(LIVE_ORDER).components;
    expect(JSON.stringify(viaMatcher)).toBe(JSON.stringify(viaPrimitive));
  });

  it('replay-safe: duplicating the backfill edges (re-scan) does not change the resolution', () => {
    const matcher = new DeterministicUnionFindMatcher();
    const once = matcher.batchResolve(BRAND, LIVE_ORDER);
    const twice = matcher.batchResolve(BRAND, [...BACKFILL_ORDER, ...BACKFILL_ORDER]);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});
