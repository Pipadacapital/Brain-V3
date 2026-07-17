/**
 * SPEC: A.2.4 (WA-19) — merge → journey re-version → unmerge → restoration round-trip (A.5.7).
 *
 * Spark-free unit round-trip over a FAKE identity graph + identity-map + the REAL application/dirty-
 * writer wiring. Asserts, end-to-end at the control-plane layer:
 *   1. GRAPH reversal — the merge interval is bi-temporally CLOSED (ALIAS_OF.valid_to set, never
 *      deleted), the absorbed node restored to independent existence, an UnmergeEvent audit node kept.
 *   2. MAP intervals — the absorbed identifier flips from SUPERSEDED (replaced_by=survivor) back to a
 *      CURRENT interval at the restored brain_id (the projection the real silver_identity_map re-reads).
 *   3. DECISION-LOG — an identity_audit action='unmerge' row is written with actor + reason (AMD-09).
 *   4. DIRTY QUEUES (ADR-0015 WS3 — replaces the retired identity.unmerged.v1 Kafka publish) — the
 *      unmerge writes {survivor, restored} DIRECTLY into ops.restitch_pending (dirty_kind='brain_id')
 *      and ops.journey_reversion_pending (cause='unmerge'), the queues the Silver identity stage drains.
 *   5. JOURNEY RE-VERSION FIRES — the enqueued (survivor, restored) pair drives the reversion job's
 *      pure derive_unmerge_pairs → the exact transfer pair the un-reversion pass moves BACK (cross-layer).
 *
 * The real Neo4j Cypher + the batch journey mutation are covered by the live suite / the reversion
 * pytest; this proves the orchestration, audit and dirty-queue contract that connect them.
 */
import { describe, it, expect, vi } from 'vitest';
import { unmergeCustomer } from '../internal/application/merge-admin.js';
import type { IdentityReader } from '../internal/infrastructure/neo4j-identity-reader.js';
import { PgIdentityUnmergeDirtyRepository } from '../../../infrastructure/pg/IdentityUnmergeDirtyRepository.js';
import type pg from 'pg';

/**
 * TS mirror of the batch reversion job's pure `derive_unmerge_pairs` row→pair contract
 * (gold journey reversion — exhaustively unit-tested in gold_journey_events_reversion_unmerge_test.py).
 * Kept intentionally tiny: it asserts the dirty rows this module enqueues carry exactly the
 * (brand, survivor→FROM, restored→TO) triple the un-reversion pass consumes to move journeys back.
 */
function derive_unmerge_pairs(
  rows: Array<{ brand_id?: string | null; survivor_brain_id?: string | null; absorbed_brain_id?: string | null }>,
): Array<[string, string, string]> {
  const seen = new Set<string>();
  const out: Array<[string, string, string]> = [];
  for (const r of rows) {
    const { brand_id: brand, survivor_brain_id: survivor, absorbed_brain_id: absorbed } = r;
    if (brand == null || survivor == null || absorbed == null) continue;
    if (survivor === absorbed) continue;
    const key = `${brand}|${survivor}|${absorbed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([brand, survivor, absorbed]);
  }
  return out;
}

const BRAND = '11111111-1111-1111-1111-111111111111';
// AMD-09: survivor = the LOWEST-UUID canonical. A (…aaaa) < B (…bbbb) ⇒ A survives, B is absorbed.
const SURVIVOR = 'aaaaaaaa-0000-0000-0000-000000000001';
const ABSORBED = 'bbbbbbbb-0000-0000-0000-000000000002';
const MERGE_ID = 'cccccccc-0000-0000-0000-000000000003';
const IDENTIFIER_HASH = 'f'.repeat(64);
const ACTOR = 'operator-user-1';

/** A fake raw pg.Pool capturing every query (text + values) the dirty writer issues. */
function makeFakePool() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (text: string, values: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    }),
  };
  return { queries, pool: pool as unknown as pg.Pool };
}

const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/**
 * A minimal in-memory identity graph + bi-temporal map modeling exactly the post-merge state, whose
 * unmergeCustomer mirrors the real reader's reversal semantics (close interval, restore node, audit,
 * return survivor+merge_id). Records the decision-log write so the test can assert it.
 */
function makeFakeGraph() {
  const graph = {
    absorbed: { brain_id: ABSORBED, lifecycle_state: 'merged', merged_into: SURVIVOR },
    aliasOf: { from: ABSORBED, to: SURVIVOR, merge_id: MERGE_ID, valid_from: 1000, valid_to: null as number | null },
    // silver_identity_map projection: the absorbed identifier currently SUPERSEDED onto the survivor.
    mapRows: [
      { identifier_hash: IDENTIFIER_HASH, brain_id: ABSORBED, is_current: false, replaced_by_brain_id: SURVIVOR, merge_event_id: MERGE_ID },
      { identifier_hash: IDENTIFIER_HASH, brain_id: SURVIVOR, is_current: true, replaced_by_brain_id: null as string | null, merge_event_id: null as string | null },
    ],
    unmergeEvents: [] as Array<Record<string, unknown>>,
    auditRows: [] as Array<Record<string, unknown>>,
  };

  const reader: Pick<IdentityReader, 'unmergeCustomer'> = {
    async unmergeCustomer(brandId, mergedBrainId, opts) {
      expect(brandId).toBe(BRAND);
      if (graph.absorbed.brain_id !== mergedBrainId || graph.absorbed.merged_into == null) {
        return { unmerged: false, reason: 'not_found' };
      }
      const survivor = graph.aliasOf.to ?? graph.absorbed.merged_into;
      const mergeId = graph.aliasOf.merge_id;
      const now = 2000;

      // 1. BI-TEMPORAL CLOSE (never destroyed) + restore the node.
      graph.aliasOf.valid_to = now;
      graph.absorbed.lifecycle_state = 'split';
      graph.absorbed.merged_into = null as unknown as string;

      // 2. MAP re-projection: superseded interval CLOSED (its replaced_by cleared), a NEW current
      //    interval opened at the restored brain_id (what the real silver_identity_map projection does
      //    once the ALIAS_OF is closed — the absorbed identifier resolves to itself again).
      for (const r of graph.mapRows) {
        if (r.brain_id === SURVIVOR && r.identifier_hash === IDENTIFIER_HASH) {
          // The survivor's borrowed interval for the absorbed's identifier is no longer current.
          r.is_current = false;
        }
        if (r.brain_id === ABSORBED && r.identifier_hash === IDENTIFIER_HASH) {
          r.is_current = true;
          r.replaced_by_brain_id = null;
          r.merge_event_id = null;
        }
      }

      // 3. AUDIT node (graph) — kept forever.
      graph.unmergeEvents.push({
        brand_id: brandId, survivor_brain_id: survivor, absorbed_brain_id: mergedBrainId,
        merge_event_id: mergeId, unmerged_at: now, actor: opts?.actor, reason: opts?.reason,
      });
      // 3b. DECISION-LOG (PG identity_audit mirror) — action='unmerge', actor + reason.
      graph.auditRows.push({
        brand_id: brandId, brain_id: mergedBrainId, action: 'unmerge', merge_id: mergeId,
        detail: { actor: opts?.actor, reason: opts?.reason, survivor_brain_id: survivor, store: 'neo4j' },
      });

      return { unmerged: true, brain_id: mergedBrainId, survivor_brain_id: survivor, merge_event_id: mergeId };
    },
  };

  return { graph, reader: reader as IdentityReader };
}

describe('A2.4 merge→unmerge round-trip (A.5.7)', () => {
  it('reverses the graph, restores the map interval, audits, enqueues dirty rows, and fires journey re-version', async () => {
    const { graph, reader } = makeFakeGraph();

    // Pre-state sanity: the merge is live.
    expect(graph.absorbed.merged_into).toBe(SURVIVOR);
    expect(graph.aliasOf.valid_to).toBeNull();
    expect(graph.mapRows.find((r) => r.brain_id === ABSORBED)!.is_current).toBe(false);

    // REAL dirty-queue writer over a fake pg pool capturing the inserts (ADR-0015 WS3).
    const { queries, pool } = makeFakePool();
    const dirtyWriter = new PgIdentityUnmergeDirtyRepository(pool, fakeLog());

    // ── ACT: the REAL application unmerge (threads actor/reason + the onUnmerged dirty seam) ──
    const result = await unmergeCustomer(BRAND, ABSORBED, reader, {
      actor: ACTOR,
      reason: 'operator confirmed two distinct people',
      onUnmerged: (evt) =>
        dirtyWriter.markUnmerged({
          brandId: evt.brandId,
          restoredBrainId: evt.restoredBrainId,
          survivorBrainId: evt.survivorBrainId,
          mergeEventId: evt.mergeEventId,
          actor: evt.actor,
          reason: evt.reason,
          correlationId: 'req-1',
        }),
    });

    // 1. RESULT surface (contract-additive fields present).
    expect(result.unmerged).toBe(true);
    expect(result.brain_id).toBe(ABSORBED);
    expect(result.survivor_brain_id).toBe(SURVIVOR);
    expect(result.merge_event_id).toBe(MERGE_ID);

    // 2. GRAPH: interval closed (not deleted), node restored, audit node kept.
    expect(graph.aliasOf.valid_to).toBe(2000);
    expect(graph.absorbed.lifecycle_state).toBe('split');
    expect(graph.absorbed.merged_into).toBeNull();
    expect(graph.unmergeEvents).toHaveLength(1);
    expect(graph.unmergeEvents[0]).toMatchObject({ survivor_brain_id: SURVIVOR, absorbed_brain_id: ABSORBED, merge_event_id: MERGE_ID, actor: ACTOR });

    // 3. MAP intervals: absorbed identifier is CURRENT at the restored brain_id again (replaced_by cleared).
    const absorbedRow = graph.mapRows.find((r) => r.brain_id === ABSORBED)!;
    expect(absorbedRow.is_current).toBe(true);
    expect(absorbedRow.replaced_by_brain_id).toBeNull();

    // 4. DECISION-LOG: action='unmerge' with actor + reason (reversible-decision-log).
    expect(graph.auditRows).toHaveLength(1);
    expect(graph.auditRows[0]).toMatchObject({ action: 'unmerge', merge_id: MERGE_ID });
    expect((graph.auditRows[0] as { detail: { actor: string } }).detail.actor).toBe(ACTOR);

    // 5. DIRTY QUEUES (ADR-0015 WS3): exactly two upserts — ops.restitch_pending (brain_id grain,
    //    the unmerge event carries no identifier hashes) + ops.journey_reversion_pending
    //    (cause='unmerge'), each covering {survivor, restored}, provenance = the reversed merge id.
    expect(queries).toHaveLength(2);
    const [restitch, reversion] = queries as [typeof queries[0], typeof queries[0]];
    expect(restitch.text).toContain('INSERT INTO ops.restitch_pending');
    expect(restitch.text).toContain('ON CONFLICT (brand_id, dirty_kind, dirty_key) DO UPDATE');
    expect(restitch.values).toEqual([
      [BRAND, BRAND],
      ['brain_id', 'brain_id'],
      [SURVIVOR, ABSORBED],
      ['identity.unmerged', 'identity.unmerged'],
      [MERGE_ID, MERGE_ID],
    ]);
    expect(reversion.text).toContain('INSERT INTO ops.journey_reversion_pending');
    expect(reversion.text).toContain('ON CONFLICT (brand_id, brain_id) DO UPDATE');
    expect(reversion.values).toEqual([
      [BRAND, BRAND],
      [SURVIVOR, ABSORBED],
      ['unmerge', 'unmerge'],
      ['identity.unmerged', 'identity.unmerged'],
      [MERGE_ID, MERGE_ID],
    ]);

    // 6. JOURNEY RE-VERSION FIRES: the enqueued (survivor, restored) pair is exactly what the batch
    //    reversion job's pure derivation turns into a transfer-back pair (old=survivor → new=restored).
    const [reversionBrands, reversionBrains] = reversion.values as [string[], string[]];
    const journeyPairs = derive_unmerge_pairs([
      { brand_id: reversionBrands[0], survivor_brain_id: reversionBrains[0], absorbed_brain_id: reversionBrains[1] },
    ]);
    expect(journeyPairs).toEqual([[BRAND, SURVIVOR, ABSORBED]]);
  });

  it('is a no-op on a brain_id that was never merged (nothing to reverse, no dirty rows)', async () => {
    const { reader } = makeFakeGraph();
    const { queries, pool } = makeFakePool();
    const dirtyWriter = new PgIdentityUnmergeDirtyRepository(pool, fakeLog());

    const NEVER_MERGED = 'dddddddd-0000-0000-0000-000000000004';
    const result = await unmergeCustomer(BRAND, NEVER_MERGED, reader, {
      actor: ACTOR,
      onUnmerged: (evt) => dirtyWriter.markUnmerged({ brandId: evt.brandId, restoredBrainId: evt.restoredBrainId, survivorBrainId: evt.survivorBrainId, mergeEventId: evt.mergeEventId, actor: evt.actor }),
    });

    expect(result.unmerged).toBe(false);
    expect(result.reason).toBe('not_found');
    expect(queries).toHaveLength(0); // onUnmerged only fires on a real reversal
  });

  it('rejects a malformed brain_id before touching the graph', async () => {
    const { reader } = makeFakeGraph();
    const spy = vi.spyOn(reader, 'unmergeCustomer');
    const result = await unmergeCustomer(BRAND, 'not-a-uuid', reader, { actor: ACTOR });
    expect(result).toEqual({ unmerged: false, reason: 'not_found' });
    expect(spy).not.toHaveBeenCalled();
  });
});
