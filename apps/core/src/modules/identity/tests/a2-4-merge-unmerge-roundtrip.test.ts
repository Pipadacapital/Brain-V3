/**
 * SPEC: A.2.4 (WA-19) — merge → journey re-version → unmerge → restoration round-trip (A.5.7).
 *
 * Spark-free unit round-trip over a FAKE identity graph + identity-map + the REAL application/publisher
 * wiring. Asserts, end-to-end at the control-plane layer:
 *   1. GRAPH reversal — the merge interval is bi-temporally CLOSED (ALIAS_OF.valid_to set, never
 *      deleted), the absorbed node restored to independent existence, an UnmergeEvent audit node kept.
 *   2. MAP intervals — the absorbed identifier flips from SUPERSEDED (replaced_by=survivor) back to a
 *      CURRENT interval at the restored brain_id (the projection the real silver_identity_map re-reads).
 *   3. DECISION-LOG — an identity_audit action='unmerge' row is written with actor + reason (AMD-09).
 *   4. EVENT — identity.unmerged.v1 (AMD-08) is produced on {env}.identity.unmerged.v1, keyed brand_id,
 *      carrying {merge_id, canonical=survivor, restored=absorbed, actor}.
 *   5. JOURNEY RE-VERSION FIRES — the emitted (survivor, absorbed) pair drives the Spark reversion job's
 *      pure derive_unmerge_pairs → the exact transfer pair the un-reversion pass moves BACK (cross-layer).
 *
 * The real Neo4j Cypher + Spark journey mutation are covered by the live suite / the reversion pytest;
 * this proves the orchestration, audit and event contract that connect them.
 */
import { describe, it, expect, vi } from 'vitest';
import { unmergeCustomer } from '../internal/application/merge-admin.js';
import type { IdentityReader } from '../internal/infrastructure/neo4j-identity-reader.js';
import { createIdentityEventPublisher } from '../../../infrastructure/events/IdentityEventPublisher.js';

/**
 * TS mirror of the Spark reversion job's pure `derive_unmerge_pairs` row→pair contract
 * (db/iceberg/spark/gold/_journey_reversion_pure.py — exhaustively unit-tested in
 * gold_journey_events_reversion_unmerge_test.py). Kept intentionally tiny: it asserts the identity
 * event this module emits carries exactly the (brand, survivor→FROM, absorbed→TO) triple the Spark
 * un-reversion pass consumes to move journeys back — the cross-layer handoff.
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
  it('reverses the graph, restores the map interval, audits, emits, and fires journey re-version', async () => {
    const { graph, reader } = makeFakeGraph();

    // Pre-state sanity: the merge is live.
    expect(graph.absorbed.merged_into).toBe(SURVIVOR);
    expect(graph.aliasOf.valid_to).toBeNull();
    expect(graph.mapRows.find((r) => r.brain_id === ABSORBED)!.is_current).toBe(false);

    // REAL identity-lane publisher over a fake kafka producer capturing the send.
    const sends: Array<{ topic: string; messages: Array<{ key?: string; value: Buffer }> }> = [];
    const producer = { send: vi.fn(async (rec: { topic: string; messages: Array<{ key?: string; value: Buffer }> }) => { sends.push(rec); }) };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const publisher = createIdentityEventPublisher({ producer: producer as never, env: 'dev', log });

    // ── ACT: the REAL application unmerge (threads actor/reason + the onUnmerged emit seam) ──
    const result = await unmergeCustomer(BRAND, ABSORBED, reader, {
      actor: ACTOR,
      reason: 'operator confirmed two distinct people',
      onUnmerged: (evt) =>
        publisher.emitUnmerged({
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

    // 5. EVENT: identity.unmerged.v1 on the env-prefixed topic, keyed brand_id, correct payload.
    expect(sends).toHaveLength(1);
    expect(sends[0]!.topic).toBe('dev.identity.unmerged.v1');
    expect(sends[0]!.messages[0]!.key).toBe(BRAND);
    const envelope = JSON.parse(sends[0]!.messages[0]!.value.toString('utf-8')) as {
      event_name: string; brand_id: string; partition_key: string;
      payload: { merge_id: string; canonical_brain_id: string; restored_brain_id: string; actor: string; rule_version: string };
    };
    expect(envelope.event_name).toBe('identity.unmerged');
    expect(envelope.partition_key).toBe(BRAND);
    expect(envelope.payload).toMatchObject({
      merge_id: MERGE_ID, canonical_brain_id: SURVIVOR, restored_brain_id: ABSORBED, actor: ACTOR, rule_version: 'v1-admin-unmerge',
    });

    // 6. JOURNEY RE-VERSION FIRES: the emitted (survivor, absorbed) pair is exactly what the Spark
    //    reversion job's pure derivation turns into a transfer-back pair (old=survivor → new=absorbed).
    const journeyPairs = derive_unmerge_pairs([
      { brand_id: envelope.brand_id, survivor_brain_id: envelope.payload.canonical_brain_id, absorbed_brain_id: envelope.payload.restored_brain_id },
    ]);
    expect(journeyPairs).toEqual([[BRAND, SURVIVOR, ABSORBED]]);
  });

  it('is a no-op on a brain_id that was never merged (nothing to reverse, no event)', async () => {
    const { reader } = makeFakeGraph();
    const sends: unknown[] = [];
    const producer = { send: vi.fn(async (rec: unknown) => { sends.push(rec); }) };
    const publisher = createIdentityEventPublisher({ producer: producer as never, env: 'dev', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    const NEVER_MERGED = 'dddddddd-0000-0000-0000-000000000004';
    const result = await unmergeCustomer(BRAND, NEVER_MERGED, reader, {
      actor: ACTOR,
      onUnmerged: (evt) => publisher.emitUnmerged({ brandId: evt.brandId, restoredBrainId: evt.restoredBrainId, survivorBrainId: evt.survivorBrainId, mergeEventId: evt.mergeEventId, actor: evt.actor }),
    });

    expect(result.unmerged).toBe(false);
    expect(result.reason).toBe('not_found');
    expect(sends).toHaveLength(0); // onUnmerged only fires on a real reversal
  });

  it('rejects a malformed brain_id before touching the graph', async () => {
    const { reader } = makeFakeGraph();
    const spy = vi.spyOn(reader, 'unmergeCustomer');
    const result = await unmergeCustomer(BRAND, 'not-a-uuid', reader, { actor: ACTOR });
    expect(result).toEqual({ unmerged: false, reason: 'not_found' });
    expect(spy).not.toHaveBeenCalled();
  });
});
