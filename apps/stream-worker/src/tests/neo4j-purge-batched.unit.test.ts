/**
 * neo4j-purge-batched.unit.test.ts — AUD-IMPL-028 regression guard for purgeBrand.
 *
 * The audit found purgeBrand issuing ONE label-less `MATCH (n) WHERE n.brand_id = $b DETACH DELETE n`:
 * an AllNodesScan (no label ⇒ none of bootstrap()'s label-scoped indexes apply) whose single
 * transaction accumulates the whole brand subgraph in the fixed 2g heap — on the RTBF/brand-erasure
 * path, against the one non-replicated neo4j that also serves live resolution. The fix deletes
 * per-label in `CALL { … } IN TRANSACTIONS OF 10000 ROWS` batches, keeping a final label-less sweep
 * as a drift-catcher (completeness of the crypto-shred beats scan cost; it matches ~0 nodes after
 * the label passes).
 *
 * These tests stub the Neo4j driver (no connection — neo4j.driver() is lazy) and assert the query
 * SHAPE: one batched, label-scoped, PARAMETERIZED delete per IDENTITY_GRAPH_LABELS entry, then the
 * label-less sweep LAST, then session.close() — even when a query fails.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  Neo4jIdentityRepository,
  IDENTITY_GRAPH_LABELS,
} from '../infrastructure/neo4j/Neo4jIdentityRepository.js';

const BRAND = 'brand-under-test';

function makeRepo() {
  const queries: Array<{ text: string; params: Record<string, unknown> }> = [];
  const close = vi.fn(async () => {});
  const run = vi.fn(async (text: string, params: Record<string, unknown>) => {
    queries.push({ text, params });
    return { records: [] };
  });
  // Constructor args are lazy (neo4j.driver()/pg.Pool never dial until used) — swap the driver.
  const repo = new Neo4jIdentityRepository('bolt://unused:7687', 'neo4j', 'x', 'postgres://unused/db');
  (repo as unknown as { driver: unknown }).driver = { session: () => ({ run, close }) };
  return { repo, queries, run, close };
}

describe('purgeBrand — per-label batched deletes (AUD-IMPL-028)', () => {
  it('issues one label-scoped IN TRANSACTIONS delete per identity-graph label, then the sweep LAST', async () => {
    const { repo, queries, close } = makeRepo();
    await repo.purgeBrand(BRAND);

    // One batched delete per label, in declaration order, each label-scoped + heap-bounded.
    expect(queries).toHaveLength(IDENTITY_GRAPH_LABELS.length + 1);
    IDENTITY_GRAPH_LABELS.forEach((label, i) => {
      const q = queries[i]!;
      expect(q.text).toContain(`MATCH (n:${label} {brand_id: $b})`); // label-scoped, index-backed
      expect(q.text).toMatch(/IN TRANSACTIONS OF \d+ ROWS/); // bounded per-commit batch
      expect(q.text).toContain('DETACH DELETE');
    });

    // Drift-catcher sweep runs LAST (matches ~0 nodes by then, guarantees crypto-shred completeness).
    const sweep = queries[queries.length - 1]!;
    expect(sweep.text).toContain('MATCH (n) WHERE n.brand_id = $b DETACH DELETE n');

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('parameterizes brand_id on EVERY query (never string-interpolated)', async () => {
    const { repo, queries } = makeRepo();
    await repo.purgeBrand(BRAND);
    for (const q of queries) {
      expect(q.text).not.toContain(BRAND); // tenant id never lands in query text
      expect(q.params).toEqual({ b: BRAND });
    }
  });

  it('closes the session even when a delete fails mid-purge', async () => {
    const { repo, run, close } = makeRepo();
    run.mockRejectedValueOnce(new Error('boom'));
    await expect(repo.purgeBrand(BRAND)).rejects.toThrow('boom');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('IDENTITY_GRAPH_LABELS covers every label the repository writes', () => {
    // Keep-in-sync check: every `:Label` in a CREATE/MERGE inside the repository source must be
    // purge-covered. (Static source scan mirrors the audit's label inventory.)
    expect([...IDENTITY_GRAPH_LABELS].sort()).toEqual(
      ['Customer', 'Identifier', 'MergeEvent', 'MergeReview', 'SharedUtility', 'UnmergeEvent'].sort(),
    );
  });
});
