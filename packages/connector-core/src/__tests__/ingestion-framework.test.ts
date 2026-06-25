import { describe, it, expect, vi } from 'vitest';
import {
  // manifest
  assertManifestValid,
  resolveBackfillFloor,
  getResource,
  backfillableResources,
  TWO_YEARS_MS,
  UNBOUNDED_BACKFILL_WINDOW_MS,
  type IngestionManifest,
  type ResourceDescriptor,
  // dedup
  buildDedupNamespace,
  deterministicDedupKeyDeriver,
  hashToUuidShaped,
  // no-loss
  deliverWithNoLoss,
  backoffDelayMs,
  DEFAULT_RETRY_POLICY,
  type IEventSink,
  type IDeadLetterSink,
  type DeadLetterRecord,
  // backfill
  runResumableBackfill,
  ResourceBackfillState,
  type IResourceBackfillStateRepository,
  type IResourcePageFetcher,
  type ResourcePage,
  type CanonicalEventDraft,
  type CanonicalEvent,
} from '../index.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const ordersResource: ResourceDescriptor = {
  name: 'orders',
  kind: 'rest',
  emits: ['order.placed.v1'],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'since_id',
  dedupKeyStrategy: 'provider_id',
  pageSize: 250,
};

const webhookResource: ResourceDescriptor = {
  name: 'order.fulfilled.webhook',
  kind: 'webhook',
  emits: ['order.fulfilled.v1'],
  backfillSupported: false,
  maxBackfillWindowMs: TWO_YEARS_MS,
  dedupKeyStrategy: 'provider_id+kind',
};

const manifest: IngestionManifest = {
  provider: 'shopify',
  resources: [ordersResource, webhookResource],
};

function draft(name: string, occurredAt: string): CanonicalEventDraft {
  return {
    event_name: name,
    occurred_at: occurredAt,
    properties: {},
    provenance: { brand_id: 'brand-1', source: 'shopify' },
  };
}

// In-memory repo + sink for the backfill driver.
function memRepo(): IResourceBackfillStateRepository & { store: Map<string, ResourceBackfillState> } {
  const store = new Map<string, ResourceBackfillState>();
  const key = (b: string, c: string, r: string) => `${b}|${c}|${r}`;
  return {
    store,
    async findByResource(b, c, r) {
      return store.get(key(b, c, r)) ?? null;
    },
    async listByConnector(b, c) {
      return [...store.values()].filter((s) => s.brandId === b && s.connectorInstanceId === c);
    },
    async listByStatus(b, c, status) {
      return [...store.values()].filter(
        (s) => s.brandId === b && s.connectorInstanceId === c && s.status === status,
      );
    },
    async upsert(state) {
      store.set(key(state.brandId, state.connectorInstanceId, state.resource), state);
      return state;
    },
  };
}

function collectingSink(): IEventSink & { events: CanonicalEvent[] } {
  const events: CanonicalEvent[] = [];
  return { events, async deliver(e) { events.push(e); } };
}

function memDlq(): IDeadLetterSink & { records: DeadLetterRecord[] } {
  const records: DeadLetterRecord[] = [];
  return { records, async spool(r) { records.push(r); } };
}

// ── manifest ─────────────────────────────────────────────────────────────────

describe('IngestionManifest', () => {
  it('accepts a valid manifest', () => {
    expect(() => assertManifestValid(manifest)).not.toThrow();
  });

  it('rejects a duplicate resource name', () => {
    expect(() =>
      assertManifestValid({ provider: 'x', resources: [ordersResource, ordersResource] }),
    ).toThrow(/duplicate resource/);
  });

  it('rejects a backfillable REST resource without a cursorStrategy', () => {
    const bad: ResourceDescriptor = { ...ordersResource };
    // @ts-expect-error intentionally drop cursorStrategy
    delete bad.cursorStrategy;
    expect(() => assertManifestValid({ provider: 'x', resources: [bad] })).toThrow(/cursorStrategy/);
  });

  it('rejects composite dedup without dedupKeyFields', () => {
    const bad: ResourceDescriptor = {
      ...ordersResource,
      dedupKeyStrategy: 'composite',
    };
    expect(() => assertManifestValid({ provider: 'x', resources: [bad] })).toThrow(/dedupKeyFields/);
  });

  it('getResource throws on an unknown resource (loud, not silent no-op)', () => {
    expect(() => getResource(manifest, 'nope')).toThrow(/declares no resource "nope"/);
    expect(getResource(manifest, 'orders').name).toBe('orders');
  });

  it('backfillableResources filters to backfillable REST resources only', () => {
    expect(backfillableResources(manifest).map((r) => r.name)).toEqual(['orders']);
  });
});

describe('resolveBackfillFloor (the "2 years or platform max" rule)', () => {
  const anchor = new Date('2026-06-25T00:00:00Z');

  it('uses the platform max when no window requested', () => {
    const floor = resolveBackfillFloor(ordersResource, anchor);
    expect(anchor.getTime() - floor.getTime()).toBe(TWO_YEARS_MS);
  });

  it('clamps a requested window LARGER than the platform max down to the max', () => {
    const tenYears = 10 * 365 * 24 * 60 * 60 * 1000;
    const floor = resolveBackfillFloor(ordersResource, anchor, tenYears);
    expect(anchor.getTime() - floor.getTime()).toBe(TWO_YEARS_MS); // clamped
  });

  it('honors a requested window SMALLER than the platform max', () => {
    const oneDay = 24 * 60 * 60 * 1000;
    const floor = resolveBackfillFloor(ordersResource, anchor, oneDay);
    expect(anchor.getTime() - floor.getTime()).toBe(oneDay);
  });

  it('UNBOUNDED sentinel is finite (no NaN under date math)', () => {
    const unbounded: ResourceDescriptor = { ...ordersResource, maxBackfillWindowMs: UNBOUNDED_BACKFILL_WINDOW_MS };
    const floor = resolveBackfillFloor(unbounded, anchor);
    expect(Number.isFinite(floor.getTime())).toBe(true);
  });
});

// ── dedup ────────────────────────────────────────────────────────────────────

describe('Dedup (deterministic event-id)', () => {
  it('provider_id namespace is tenant-led and equals hashToUuidShaped of the namespace', () => {
    const ns = buildDedupNamespace({ brandId: 'brand-1', provider: 'shopify', resource: ordersResource, providerId: '999' });
    expect(ns).toBe('brand-1:shopify:orders:999');
    const id = deterministicDedupKeyDeriver.deriveEventId({ brandId: 'brand-1', provider: 'shopify', resource: ordersResource, providerId: '999' });
    expect(id).toBe(hashToUuidShaped(ns));
  });

  it('same fact → same id (idempotent across replays)', () => {
    const a = deterministicDedupKeyDeriver.deriveEventId({ brandId: 'b', provider: 'shopify', resource: ordersResource, providerId: '1' });
    const b = deterministicDedupKeyDeriver.deriveEventId({ brandId: 'b', provider: 'shopify', resource: ordersResource, providerId: '1' });
    expect(a).toBe(b);
  });

  it('different brands with the same upstream id never collide (multi-tenancy)', () => {
    const a = deterministicDedupKeyDeriver.deriveEventId({ brandId: 'b1', provider: 'shopify', resource: ordersResource, providerId: '1' });
    const b = deterministicDedupKeyDeriver.deriveEventId({ brandId: 'b2', provider: 'shopify', resource: ordersResource, providerId: '1' });
    expect(a).not.toBe(b);
  });

  it('provider_id+kind folds the event_name in (one id → many event kinds)', () => {
    const ns = buildDedupNamespace({ brandId: 'b', provider: 'shopify', resource: webhookResource, providerId: '1', eventName: 'order.fulfilled.v1' });
    expect(ns).toBe('b:shopify:order.fulfilled.webhook:1:order.fulfilled.v1');
    const placed = deterministicDedupKeyDeriver.deriveEventId({ brandId: 'b', provider: 'shopify', resource: webhookResource, providerId: '1', eventName: 'order.placed.v1' });
    const fulfilled = deterministicDedupKeyDeriver.deriveEventId({ brandId: 'b', provider: 'shopify', resource: webhookResource, providerId: '1', eventName: 'order.fulfilled.v1' });
    expect(placed).not.toBe(fulfilled);
  });

  it('composite dedup requires the right number of values', () => {
    const r: ResourceDescriptor = { ...ordersResource, dedupKeyStrategy: 'composite', dedupKeyFields: ['a', 'b'] };
    expect(() => buildDedupNamespace({ brandId: 'b', provider: 'x', resource: r, compositeValues: ['only-one'] })).toThrow(/expects 2 value/);
    const ns = buildDedupNamespace({ brandId: 'b', provider: 'x', resource: r, compositeValues: ['v1', 'v2'] });
    expect(ns.startsWith('b:x:orders:')).toBe(true);
  });

  it('throws when provider_id dedup is missing the providerId', () => {
    expect(() => buildDedupNamespace({ brandId: 'b', provider: 'x', resource: ordersResource })).toThrow(/providerId is missing/);
  });
});

// ── no-loss ──────────────────────────────────────────────────────────────────

describe('NoLoss (retry + DLQ)', () => {
  const ev = (): CanonicalEvent => ({
    event_name: 'order.placed.v1',
    occurred_at: '2026-01-01T00:00:00Z',
    properties: {},
    provenance: { brand_id: 'brand-1', source: 'shopify', event_id: 'evt-1' },
  });

  it('backoff is exponential and capped', () => {
    const p = { maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 800 };
    expect(backoffDelayMs(p, 1)).toBe(0);
    expect(backoffDelayMs(p, 2)).toBe(100);
    expect(backoffDelayMs(p, 3)).toBe(200);
    expect(backoffDelayMs(p, 4)).toBe(400);
    expect(backoffDelayMs(p, 5)).toBe(800);
    expect(backoffDelayMs(p, 6)).toBe(800); // capped
  });

  it('delivers on the first try (no DLQ)', async () => {
    const sink = collectingSink();
    const dlq = memDlq();
    const out = await deliverWithNoLoss({ event: ev(), resource: 'orders', sink, dlq, sleep: async () => {} });
    expect(out.delivered).toBe(true);
    expect(out.spooledToDlq).toBe(false);
    expect(sink.events).toHaveLength(1);
    expect(dlq.records).toHaveLength(0);
  });

  it('retries a flaky sink then succeeds', async () => {
    let calls = 0;
    const sink: IEventSink = { async deliver() { calls += 1; if (calls < 3) throw new Error('flaky'); } };
    const dlq = memDlq();
    const out = await deliverWithNoLoss({ event: ev(), resource: 'orders', sink, dlq, sleep: async () => {} });
    expect(out.delivered).toBe(true);
    expect(out.attempts).toBe(3);
    expect(dlq.records).toHaveLength(0);
  });

  it('spools to the DLQ (never drops) after exhausting attempts', async () => {
    const sink: IEventSink = { async deliver() { throw new Error('always down'); } };
    const dlq = memDlq();
    const out = await deliverWithNoLoss({ event: ev(), resource: 'orders', sink, dlq, sleep: async () => {} });
    expect(out.delivered).toBe(false);
    expect(out.spooledToDlq).toBe(true);
    expect(out.attempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(dlq.records).toHaveLength(1);
    expect(dlq.records[0]!.eventId).toBe('evt-1'); // deterministic id preserved for replay
    expect(dlq.records[0]!.failureReason).toContain('always down');
  });

  it('propagates loudly if the DLQ spool ITSELF fails (no silent loss)', async () => {
    const sink: IEventSink = { async deliver() { throw new Error('sink down'); } };
    const dlq: IDeadLetterSink = { async spool() { throw new Error('dlq down too'); } };
    await expect(
      deliverWithNoLoss({ event: ev(), resource: 'orders', sink, dlq, sleep: async () => {} }),
    ).rejects.toThrow(/dlq down too/);
  });
});

// ── ResourceBackfillState entity ───────────────────────────────────────────────

describe('ResourceBackfillState', () => {
  const base = () =>
    ResourceBackfillState.create({
      id: 's1',
      brandId: 'b',
      connectorInstanceId: 'c',
      resource: 'orders',
      status: 'queued',
      anchorAt: new Date('2026-06-25T00:00:00Z'),
      floorAt: new Date('2024-06-25T00:00:00Z'),
      cursor: null,
      reachedAt: null,
      recordsProcessed: 0,
      failureReason: null,
      updatedAt: new Date('2026-06-25T00:00:00Z'),
    });

  it('rejects floorAt after anchorAt', () => {
    expect(() =>
      ResourceBackfillState.create({ ...base().toProps(), floorAt: new Date('2027-01-01T00:00:00Z') }),
    ).toThrow(/floorAt must be <= anchorAt/);
  });

  it('checkpoint advances cursor + deepens reachedAt monotonically + adds count', () => {
    const s1 = base().start().checkpoint({ cursor: '100', reachedAt: new Date('2026-03-01T00:00:00Z'), processedDelta: 5 });
    expect(s1.cursor).toBe('100');
    expect(s1.recordsProcessed).toBe(5);
    // a LATER reachedAt (newer) must NOT move the deepest reached forward
    const s2 = s1.checkpoint({ cursor: '200', reachedAt: new Date('2026-05-01T00:00:00Z'), processedDelta: 3 });
    expect(s2.reachedAt).toEqual(new Date('2026-03-01T00:00:00Z')); // unchanged (deeper kept)
    expect(s2.recordsProcessed).toBe(8);
  });

  it('hasReachedFloor flips once reachedAt crosses the floor', () => {
    const s = base().start().checkpoint({ cursor: 'x', reachedAt: new Date('2024-01-01T00:00:00Z'), processedDelta: 1 });
    expect(s.hasReachedFloor).toBe(true);
  });

  it('fail preserves cursor + truncates reason; isResumable false when completed', () => {
    const failed = base().start().checkpoint({ cursor: 'keep-me', reachedAt: new Date('2026-05-01T00:00:00Z'), processedDelta: 1 }).fail('boom');
    expect(failed.status).toBe('failed');
    expect(failed.cursor).toBe('keep-me');
    expect(base().complete().isResumable).toBe(false);
  });
});

// ── runResumableBackfill driver ────────────────────────────────────────────────

describe('runResumableBackfill', () => {
  const anchor = new Date('2026-06-25T00:00:00Z');

  // A fake fetcher that yields N pages then ends. Each page is 1 record/event, getting older.
  function pagedFetcher(pages: ResourcePage[]): IResourcePageFetcher {
    let i = 0;
    return {
      async fetchPage() {
        const page = pages[i] ?? { records: [], nextCursor: null };
        i += 1;
        return page;
      },
    };
  }

  function recordPage(id: string, occurredAt: string, nextCursor: string | null): ResourcePage {
    return {
      records: [{ providerId: id, events: [draft('order.placed.v1', occurredAt)] }],
      nextCursor,
      oldestOccurredAt: new Date(occurredAt),
    };
  }

  it('walks all pages to completion, stamps deterministic ids, persists final state', async () => {
    const repo = memRepo();
    const sink = collectingSink();
    const dlq = memDlq();
    const fetcher = pagedFetcher([
      recordPage('1', '2026-06-01T00:00:00Z', 'cur-1'),
      recordPage('2', '2026-05-01T00:00:00Z', 'cur-2'),
      recordPage('3', '2026-04-01T00:00:00Z', null), // null ends the walk
    ]);

    const res = await runResumableBackfill({
      brandId: 'b', connectorInstanceId: 'c', provider: 'shopify', resource: ordersResource,
      fetcher, sink, dlq, stateRepo: repo, anchor, idFactory: () => 's1',
    });

    expect(res.stopReason).toBe('completed');
    expect(sink.events).toHaveLength(3);
    expect(res.state.status).toBe('completed');
    expect(res.state.recordsProcessed).toBe(3);
    // ids are the deterministic dedup ids
    expect(sink.events[0]!.provenance.event_id).toBe(
      deterministicDedupKeyDeriver.deriveEventId({ brandId: 'b', provider: 'shopify', resource: ordersResource, providerId: '1', eventName: 'order.placed.v1' }),
    );
  });

  it('pauses at the per-run chunk budget and RESUMES from the persisted cursor (interval scheduling)', async () => {
    const repo = memRepo();
    const sink = collectingSink();
    const dlq = memDlq();

    // First run: only 1 chunk allowed.
    const run1 = await runResumableBackfill({
      brandId: 'b', connectorInstanceId: 'c', provider: 'shopify', resource: ordersResource,
      fetcher: pagedFetcher([
        recordPage('1', '2026-06-01T00:00:00Z', 'cur-after-1'),
        recordPage('2', '2026-05-01T00:00:00Z', null),
      ]),
      sink, dlq, stateRepo: repo, anchor, maxChunksThisRun: 1, idFactory: () => 's1',
    });
    expect(run1.stopReason).toBe('paused');
    expect(run1.state.status).toBe('paused');
    expect(run1.state.cursor).toBe('cur-after-1');
    expect(sink.events).toHaveLength(1);

    // Second run: a fresh fetcher that ASSERTS it resumes from the persisted cursor.
    const seenCursors: (string | null)[] = [];
    const resumeFetcher: IResourcePageFetcher = {
      async fetchPage(a) {
        seenCursors.push(a.cursor);
        return { records: [{ providerId: '2', events: [draft('order.placed.v1', '2026-05-01T00:00:00Z')] }], nextCursor: null, oldestOccurredAt: new Date('2026-05-01T00:00:00Z') };
      },
    };
    const run2 = await runResumableBackfill({
      brandId: 'b', connectorInstanceId: 'c', provider: 'shopify', resource: ordersResource,
      fetcher: resumeFetcher, sink, dlq, stateRepo: repo, anchor, idFactory: () => 's1',
    });
    expect(seenCursors[0]).toBe('cur-after-1'); // resumed from the checkpoint, not from scratch
    expect(run2.stopReason).toBe('completed');
    expect(run2.state.recordsProcessed).toBe(2); // lifetime count across both runs
  });

  it('completes once the historical floor is reached even if more pages exist', async () => {
    const repo = memRepo();
    const sink = collectingSink();
    const dlq = memDlq();
    // oldestOccurredAt below the 2yr floor → driver completes after this chunk.
    const fetcher = pagedFetcher([recordPage('1', '2023-01-01T00:00:00Z', 'more-pages-exist')]);
    const res = await runResumableBackfill({
      brandId: 'b', connectorInstanceId: 'c', provider: 'shopify', resource: ordersResource,
      fetcher, sink, dlq, stateRepo: repo, anchor, idFactory: () => 's1',
    });
    expect(res.stopReason).toBe('completed');
    expect(res.state.hasReachedFloor).toBe(true);
  });

  it('a re-trigger of a completed backfill is a no-op (idempotent)', async () => {
    const repo = memRepo();
    const sink = collectingSink();
    const dlq = memDlq();
    const fetcher = pagedFetcher([recordPage('1', '2026-06-01T00:00:00Z', null)]);
    await runResumableBackfill({ brandId: 'b', connectorInstanceId: 'c', provider: 'shopify', resource: ordersResource, fetcher, sink, dlq, stateRepo: repo, anchor, idFactory: () => 's1' });
    expect(sink.events).toHaveLength(1);

    const again = await runResumableBackfill({ brandId: 'b', connectorInstanceId: 'c', provider: 'shopify', resource: ordersResource, fetcher: pagedFetcher([recordPage('2', '2026-05-01T00:00:00Z', null)]), sink, dlq, stateRepo: repo, anchor, idFactory: () => 's1' });
    expect(again.stopReason).toBe('completed');
    expect(sink.events).toHaveLength(1); // no new emissions
  });

  it('an auth error fails the run but PRESERVES the cursor for a later resume', async () => {
    const repo = memRepo();
    const sink = collectingSink();
    const dlq = memDlq();
    // First a good page (checkpoints cur-1), then a throw.
    let call = 0;
    const fetcher: IResourcePageFetcher = {
      async fetchPage() {
        call += 1;
        if (call === 1) return recordPage('1', '2026-06-01T00:00:00Z', 'cur-1');
        throw new Error('401 RECONNECT_REQUIRED');
      },
    };
    const res = await runResumableBackfill({ brandId: 'b', connectorInstanceId: 'c', provider: 'shopify', resource: ordersResource, fetcher, sink, dlq, stateRepo: repo, anchor, idFactory: () => 's1' });
    expect(res.stopReason).toBe('failed');
    expect(res.state.status).toBe('failed');
    expect(res.state.cursor).toBe('cur-1'); // preserved → resume, not restart
    expect(res.state.failureReason).toContain('RECONNECT_REQUIRED');
  });

  it('rejects a resource that does not support backfill', async () => {
    const repo = memRepo();
    await expect(
      runResumableBackfill({ brandId: 'b', connectorInstanceId: 'c', provider: 'shopify', resource: webhookResource, fetcher: pagedFetcher([]), sink: collectingSink(), dlq: memDlq(), stateRepo: repo, anchor }),
    ).rejects.toThrow(/does not support backfill/);
  });
});
