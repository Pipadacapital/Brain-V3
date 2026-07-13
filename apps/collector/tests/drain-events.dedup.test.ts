/**
 * drain-events.dedup.test.ts — ADR-0012 ingest dedup gate on the pixel/collector drain path.
 *
 * Locks the behaviour the "no event loss" invariant depends on:
 *   1. A keyable entry whose event_id is already SEEN is DROPPED (not produced) but still drained.
 *   2. A keyable UNSEEN entry is produced and marked seen.
 *   3. An entry missing brand_id or event_id CANNOT be keyed → it is ALWAYS produced, never deduped.
 *   4. ORDER: produce FIRST, THEN markEventsSeen + markDrained + commit (crash-safety invariant).
 *   5. markEventsSeen records ONLY produced pairs; markDrained drains ALL claimed ids (incl. drops).
 *
 * Hermetic: fakes the spool claim (with a spy client), the Kafka producer, and the injected dedup
 * helpers — no DB, no broker. incrementCounter/log are stubbed via the @brain/observability mock.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ClientBase } from 'pg';
import { DrainEventsUseCase, type IngestDedup } from '../src/application/drain-events.usecase.js';
import type { SpoolClaim, SpoolRepository } from '../src/domain/ingest/repositories/spool.repository.js';
import type { PendingSpoolEntry } from '../src/domain/ingest/entities/spool-entry.js';
import type { CollectorKafkaProducer } from '../src/infrastructure/kafka-producer.js';
import type { DedupPair } from '../src/infrastructure/ingest-dedup.repository.js';

vi.mock('@brain/observability', () => ({
  incrementCounter: () => undefined,
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

const BRAND = '11111111-1111-1111-1111-111111111111';

function entry(id: bigint, brandId: string | null, eventId: string | null): PendingSpoolEntry {
  return {
    id,
    rawBodyText: JSON.stringify({ brand_id: brandId, event_id: eventId }),
    correlationId: null,
    brandId,
    eventId,
  };
}

/**
 * Records the exact call order across produce / mark-seen / mark-drained / commit. `committed` and
 * `rolledBack` are getters so the harness reflects live counter mutations (spreading them by value
 * would snapshot 0). Arrays/`order` are shared references so they mutate in place.
 */
interface Harness {
  usecase: DrainEventsUseCase;
  order: string[];
  produced: { eventId: string | null }[][];
  markedSeen: DedupPair[][];
  drainedIds: bigint[][];
  readonly committed: number;
  readonly rolledBack: number;
}

function buildHarness(opts: {
  entries: PendingSpoolEntry[];
  seenEventIds: Set<string>;
  produceThrows?: boolean;
}): Harness {
  const state = {
    order: [] as string[],
    produced: [] as { eventId: string | null }[][],
    markedSeen: [] as DedupPair[][],
    drainedIds: [] as bigint[][],
    committed: 0,
    rolledBack: 0,
  };

  const client = { __tag: 'claim-client' } as unknown as ClientBase;

  const claim: SpoolClaim = {
    entries: opts.entries,
    client,
    markDrained: async (ids: bigint[]) => {
      state.order.push('markDrained');
      state.drainedIds.push(ids);
    },
    commit: async () => {
      state.order.push('commit');
      state.committed += 1;
    },
    rollback: async () => {
      state.rolledBack += 1;
    },
  };

  const spool: SpoolRepository = {
    insert: async () => 0n,
    insertMany: async () => [],
    claimPending: async () => claim,
    countPendingBounded: async () => 0,
    reapDrained: async () => 0,
    ping: async () => true,
  };

  const kafka = {
    produceBatch: async (batch: { eventId: string | null }[]) => {
      if (opts.produceThrows) {
        state.order.push('produceFailed');
        throw new Error('redpanda down');
      }
      state.order.push('produce');
      state.produced.push(batch.map((m) => ({ eventId: m.eventId })));
    },
  } as unknown as CollectorKafkaProducer;

  const dedup: IngestDedup = {
    filterUnseenEventIds: async (c: ClientBase, pairs: DedupPair[]) => {
      // Assert the read runs on the claim's own client (same txn as mark-drained).
      expect(c).toBe(client);
      return new Set(pairs.map((p) => p.eventId).filter((id) => !opts.seenEventIds.has(id)));
    },
    markEventsSeen: async (c: ClientBase, pairs: DedupPair[]) => {
      expect(c).toBe(client);
      state.order.push('markEventsSeen');
      state.markedSeen.push(pairs);
    },
  };

  return {
    usecase: new DrainEventsUseCase(spool, kafka, 100, dedup),
    order: state.order,
    produced: state.produced,
    markedSeen: state.markedSeen,
    drainedIds: state.drainedIds,
    get committed() {
      return state.committed;
    },
    get rolledBack() {
      return state.rolledBack;
    },
  };
}

describe('DrainEventsUseCase — ADR-0012 ingest dedup gate', () => {
  it('drops a seen event, keeps an unseen one, and always produces null-keyed entries', async () => {
    const seen = entry(1n, BRAND, 'aaaaaaaa-0000-0000-0000-000000000001'); // already ingested → drop
    const unseen = entry(2n, BRAND, 'aaaaaaaa-0000-0000-0000-000000000002'); // new → produce
    const nullBrand = entry(3n, null, 'aaaaaaaa-0000-0000-0000-000000000003'); // unkeyable → produce
    const nullEvent = entry(4n, BRAND, null); // unkeyable → produce

    const h = buildHarness({
      entries: [seen, unseen, nullBrand, nullEvent],
      seenEventIds: new Set([seen.eventId as string]),
    });

    const drained = await h.usecase.execute();

    // Produced = unseen keyable ∪ both null-keyed entries; seen dup is NOT produced.
    expect(h.produced).toHaveLength(1);
    const producedIds = h.produced[0]!.map((m) => m.eventId);
    expect(producedIds).toEqual([unseen.eventId, nullBrand.eventId, nullEvent.eventId]);

    // Mark-seen records ONLY the produced keyable pair (the unseen one) — never the null-keyed ones.
    expect(h.markedSeen).toHaveLength(1);
    expect(h.markedSeen[0]).toEqual([{ brandId: BRAND, eventId: unseen.eventId }]);

    // ALL four claimed rows are drained (the dropped dup is drained too, just not re-produced).
    expect(h.drainedIds[0]).toEqual([1n, 2n, 3n, 4n]);

    // Return value = rows drained this batch = every claimed row.
    expect(drained).toBe(4);
    expect(h.committed).toBe(1);
    expect(h.rolledBack).toBe(0);
  });

  it('produces BEFORE marking seen/drained then commits (crash-safety order)', async () => {
    const e = entry(1n, BRAND, 'bbbbbbbb-0000-0000-0000-000000000001');
    const h = buildHarness({ entries: [e], seenEventIds: new Set() });

    await h.usecase.execute();

    // The whole point of ADR-0012: produce is durable BEFORE any mark. A crash between at worst
    // re-produces a dup (Silver backstops) — it never loses an event.
    expect(h.order).toEqual(['produce', 'markEventsSeen', 'markDrained', 'commit']);
  });

  it('on produce failure: rolls back, marks NOTHING, produces NOTHING durable, returns 0 (F-3)', async () => {
    const e = entry(1n, BRAND, 'cccccccc-0000-0000-0000-000000000001');
    const h = buildHarness({ entries: [e], seenEventIds: new Set(), produceThrows: true });

    const drained = await h.usecase.execute();

    expect(drained).toBe(0);
    expect(h.produced).toHaveLength(0);
    expect(h.markedSeen).toHaveLength(0);
    expect(h.drainedIds).toHaveLength(0);
    expect(h.committed).toBe(0);
    expect(h.rolledBack).toBe(1);
    // produce was attempted and failed; nothing was marked after it.
    expect(h.order).toEqual(['produceFailed']);
  });

  it('all-seen batch: produces nothing but still drains every claimed row', async () => {
    const a = entry(1n, BRAND, 'dddddddd-0000-0000-0000-000000000001');
    const b = entry(2n, BRAND, 'dddddddd-0000-0000-0000-000000000002');
    const h = buildHarness({
      entries: [a, b],
      seenEventIds: new Set([a.eventId as string, b.eventId as string]),
    });

    const drained = await h.usecase.execute();

    // Nothing to produce (both already ingested) — produceBatch is skipped entirely.
    expect(h.produced).toHaveLength(0);
    // markEventsSeen still runs with an EMPTY produced set (no-op), then all rows drain + commit.
    expect(h.markedSeen[0]).toEqual([]);
    expect(h.drainedIds[0]).toEqual([1n, 2n]);
    expect(drained).toBe(2);
    expect(h.committed).toBe(1);
    expect(h.order).toEqual(['markEventsSeen', 'markDrained', 'commit']);
  });
});
