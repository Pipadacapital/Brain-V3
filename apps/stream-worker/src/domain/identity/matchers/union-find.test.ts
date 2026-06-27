/**
 * union-find.test.ts — the batch connected-components helper.
 *
 * The load-bearing property is ORDER-INDEPENDENCE: a backfill that sees the edges in any order
 * (or replays them) must produce the SAME components and the SAME canonical (lowest-UUID) survivor
 * the stream resolver would build event-by-event. We prove it by shuffling the edge order across
 * many permutations and asserting byte-identical output.
 */
import { describe, it, expect } from 'vitest';
import { computeConnectedComponents, type IdentifierBrainEdge } from './union-find.js';

// Stable, sortable UUIDs (lexicographic order == the canonical-survivor order).
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';
const D = '00000000-0000-0000-0000-00000000000d';
const E = '00000000-0000-0000-0000-00000000000e';

const k = (n: number) => `email:${String(n).padStart(64, '0')}`;

/** Deterministic Fisher–Yates using a seeded LCG so the shuffle is reproducible across CI runs. */
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

describe('computeConnectedComponents — order-independent union-find', () => {
  it('unions two brain_ids that share an identifier; canonical = lowest UUID', () => {
    // B and A both linked via the same email → one component, canonical = A (lowest).
    const edges: IdentifierBrainEdge[] = [
      { identifier_key: k(1), brain_id: B },
      { identifier_key: k(1), brain_id: A },
    ];
    const { components, canonicalOf } = computeConnectedComponents(edges);
    expect(components).toEqual([{ canonical: A, members: [A, B] }]);
    expect(canonicalOf.get(A)).toBe(A);
    expect(canonicalOf.get(B)).toBe(A);
  });

  it('transitively connects a chain A–B–C–D into one component (canonical = lowest)', () => {
    const edges: IdentifierBrainEdge[] = [
      { identifier_key: k(1), brain_id: B },
      { identifier_key: k(1), brain_id: C },
      { identifier_key: k(2), brain_id: C },
      { identifier_key: k(2), brain_id: D },
      { identifier_key: k(3), brain_id: D },
      { identifier_key: k(3), brain_id: A },
    ];
    const { components } = computeConnectedComponents(edges);
    expect(components).toEqual([{ canonical: A, members: [A, B, C, D] }]);
  });

  it('keeps disjoint groups separate; output sorted by canonical', () => {
    // {A,C} share k(1); {B,E} share k(2); D is a singleton (its own canonical).
    const edges: IdentifierBrainEdge[] = [
      { identifier_key: k(1), brain_id: C },
      { identifier_key: k(1), brain_id: A },
      { identifier_key: k(2), brain_id: E },
      { identifier_key: k(2), brain_id: B },
      { identifier_key: k(9), brain_id: D },
    ];
    const { components } = computeConnectedComponents(edges);
    expect(components).toEqual([
      { canonical: A, members: [A, C] },
      { canonical: B, members: [B, E] },
      { canonical: D, members: [D] },
    ]);
  });

  it('ORDER-INDEPENDENCE: shuffling edge order yields byte-identical components', () => {
    const edges: IdentifierBrainEdge[] = [
      { identifier_key: k(1), brain_id: B },
      { identifier_key: k(1), brain_id: C },
      { identifier_key: k(2), brain_id: C },
      { identifier_key: k(2), brain_id: D },
      { identifier_key: k(3), brain_id: D },
      { identifier_key: k(3), brain_id: A },
      { identifier_key: k(5), brain_id: E }, // separate singleton-ish edge
    ];
    const baseline = computeConnectedComponents(edges);
    for (let seed = 1; seed <= 50; seed++) {
      const result = computeConnectedComponents(shuffle(edges, seed));
      expect(result.components).toEqual(baseline.components);
      expect([...result.canonicalOf.entries()].sort()).toEqual(
        [...baseline.canonicalOf.entries()].sort(),
      );
    }
  });

  it('is idempotent under duplicate edges (replay-safe)', () => {
    const edges: IdentifierBrainEdge[] = [
      { identifier_key: k(1), brain_id: A },
      { identifier_key: k(1), brain_id: B },
    ];
    const once = computeConnectedComponents(edges);
    const twice = computeConnectedComponents([...edges, ...edges, ...edges]);
    expect(twice.components).toEqual(once.components);
  });

  it('handles the empty batch', () => {
    const { components, canonicalOf } = computeConnectedComponents([]);
    expect(components).toEqual([]);
    expect(canonicalOf.size).toBe(0);
  });
});
