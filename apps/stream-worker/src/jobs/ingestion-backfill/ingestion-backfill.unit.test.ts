/**
 * ingestion-backfill.unit.test.ts — proves the ingestion framework onboarding end-to-end with the
 * REAL @brain/connector-core driver, the REAL Shopify/WooCommerce manifests, and in-memory sinks.
 *
 * What this asserts (the slice's three guarantees):
 *   1. MULTI-RESOURCE   — products + customers + refunds + fulfillments (Shopify) and orders +
 *      products (Woo) all run through the SAME generic driver via the manifest.
 *   2. RESUMABLE/CHUNKED — a bounded maxChunksThisRun run pauses + checkpoints; the next run
 *      resumes from the persisted cursor (does NOT restart) and completes.
 *   3. STRICT DEDUP, NO LOSS — overlapping a completed chunk re-emits records that derive the SAME
 *      deterministic event_id (Bronze would drop them); a sink that always fails spools EVERY event
 *      to the DLQ (none lost).
 *
 * Plus: the runtime sinks (KafkaEventSink envelope projection + PgDeadLetterSink address derivation)
 * are unit-checked with a fake producer / repo (no real Kafka/PG).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runResumableBackfill,
  getResource,
  ResourceBackfillState,
  deterministicDedupKeyDeriver,
  type IResourcePageFetcher,
  type ResourcePage,
  type IEventSink,
  type IDeadLetterSink,
  type CanonicalEvent,
  type DeadLetterRecord,
  type IResourceBackfillStateRepository,
  type ResourceBackfillStatus,
} from '@brain/connector-core';
import {
  SHOPIFY_MANIFEST,
  mapProductToDraft,
  type ShopifyProductShape,
} from '@brain/shopify-mapper';
import { WOOCOMMERCE_MANIFEST } from '@brain/woocommerce-mapper';
import { ORDER_BACKFILL_V1_TOPIC_SUFFIX, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
import { KafkaEventSink, PgDeadLetterSink, frameworkDlqTopic } from './sinks.js';
import {
  BACKFILL_TOPIC,
  WOOCOMMERCE_SCHEDULED_BACKFILL_RESOURCES,
  SHOPIFY_SCHEDULED_BACKFILL_RESOURCES,
} from './run.js';
import { parseRequestedWindowMs } from '../../infrastructure/pg/BackfillJobRepository.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const CONNECTOR = '99999999-9999-9999-9999-999999999999';

// ── In-memory framework collaborators ─────────────────────────────────────────

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
    async listByStatus(b, c, status: ResourceBackfillStatus) {
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

/** A sink that records every delivered event_id (so we can assert dedup + no-loss). */
function memSink(): IEventSink & { delivered: string[] } {
  const delivered: string[] = [];
  return {
    delivered,
    async deliver(event: CanonicalEvent) {
      delivered.push(event.provenance.event_id);
    },
  };
}

function memDlq(): IDeadLetterSink & { spooled: DeadLetterRecord[] } {
  const spooled: DeadLetterRecord[] = [];
  return {
    spooled,
    async spool(record) {
      spooled.push(record);
    },
  };
}

/**
 * A fake page-fetcher backed by an in-memory array of Shopify products, paged by since_id (the
 * SAME contract the real ShopifyProductsFetcher honours). One page == `pageSize` records.
 */
function fakeProductFetcher(products: ShopifyProductShape[], pageSize: number): IResourcePageFetcher {
  const sorted = [...products].sort((a, b) => Number(a.id) - Number(b.id));
  return {
    async fetchPage(args): Promise<ResourcePage> {
      const sinceId = args.cursor ? Number(args.cursor.split(':')[0]) : 0;
      const slice = sorted.filter((p) => Number(p.id) > sinceId).slice(0, pageSize);
      const records = slice.map((p) => {
        const m = mapProductToDraft(p, BRAND);
        return { providerId: m.providerId, events: m.events };
      });
      const last = slice[slice.length - 1];
      // since_id cursor uses the raw product id (the fetcher's pagination key), distinct from the
      // per-state dedup providerId; null when the page wasn't full (no more pages).
      const nextCursor = slice.length === pageSize && last ? `${last.id}` : null;
      let oldest: Date | undefined;
      for (const p of slice) {
        const d = new Date(p.updated_at ?? p.created_at ?? 0);
        if (!oldest || d < oldest) oldest = d;
      }
      return { records, nextCursor, ...(oldest ? { oldestOccurredAt: oldest } : {}) };
    },
  };
}

function makeProducts(n: number, baseMs = Date.parse('2026-06-01T00:00:00Z')): ShopifyProductShape[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    title: `P${i}`,
    handle: `p-${i}`,
    status: 'active',
    updated_at: new Date(baseMs + i * 1000).toISOString(),
    variants: [{ id: 9000 + i, sku: `SKU-${i}`, price: '100.00', inventory_quantity: i }],
  }));
}

describe('ingestion framework — multi-resource onboarding via the generic driver', () => {
  it('backfills Shopify products through the real driver (manifest + dedup + no-loss)', async () => {
    const resource = getResource(SHOPIFY_MANIFEST, 'products');
    const fetcher = fakeProductFetcher(makeProducts(5), 2);
    const sink = memSink();
    const dlq = memDlq();
    const repo = memRepo();

    const result = await runResumableBackfill({
      brandId: BRAND,
      connectorInstanceId: CONNECTOR,
      provider: 'shopify',
      resource,
      fetcher,
      sink,
      dlq,
      stateRepo: repo,
      requestedWindowMs: 365 * 24 * 60 * 60 * 1000 * 5, // wide window so the floor isn't hit early
      idFactory: () => 'state-products',
    });

    expect(result.stopReason).toBe('completed');
    expect(sink.delivered).toHaveLength(5);
    expect(dlq.spooled).toHaveLength(0);
    // event_ids are deterministic + unique per product state
    expect(new Set(sink.delivered).size).toBe(5);
  });

  it('exposes the same generic path for both connectors (WooCommerce orders + products declared)', () => {
    expect(() => getResource(WOOCOMMERCE_MANIFEST, 'orders')).not.toThrow();
    expect(() => getResource(WOOCOMMERCE_MANIFEST, 'products')).not.toThrow();
    // a typo fails loud (not a silent no-op)
    expect(() => getResource(WOOCOMMERCE_MANIFEST, 'nope')).toThrow();
  });

  it('declares ALL backfillable WooCommerce resources (products + customers + coupons + refunds)', () => {
    for (const r of ['products', 'customers', 'coupons', 'refunds']) {
      expect(() => getResource(WOOCOMMERCE_MANIFEST, r)).not.toThrow();
    }
  });

  it('the scheduled resource set drives the 4 non-order resources and EXCLUDES orders (no double-count)', () => {
    expect([...WOOCOMMERCE_SCHEDULED_BACKFILL_RESOURCES].sort()).toEqual(
      ['coupons', 'customers', 'products', 'refunds'],
    );
    // Orders flow on the live lane via woocommerce-orders-repull (uuidV5FromOrderLive event_id);
    // driving them through the framework too would mint a different id → duplicate Bronze rows.
    expect(WOOCOMMERCE_SCHEDULED_BACKFILL_RESOURCES).not.toContain('orders');
  });

  it('GUARD: WooCommerce ORDERS must NEVER enter the generic backfill framework (double-count)', () => {
    // DO NOT add 'orders' to WOOCOMMERCE_SCHEDULED_BACKFILL_RESOURCES.
    //
    // The live/repull lane ids a Woo order as
    //     uuidV5FromOrderLive(brandId, orderId, date_modifiedMs)
    // while the generic ingestion-backfill framework would derive its Bronze event_id from
    //     providerId = `${orderId}:${stateMs}`
    // — a DIFFERENT deterministic id for the SAME order state. Bronze dedups on (brand_id,
    // event_id), so the two namespaces never collapse: every backfilled order would land a SECOND
    // time and the revenue ledger would double-count. The ONLY thing preventing that today is this
    // exclusion (see WOOCOMMERCE_SCHEDULED_BACKFILL_RESOURCES + the runIngestionBackfillFromQueue
    // docstring in ingestion-backfill/run.ts). If deeper Woo order history is needed, extend the
    // live-lane woocommerce-orders-repull window — never route orders through the framework.
    expect(WOOCOMMERCE_SCHEDULED_BACKFILL_RESOURCES).not.toContain('orders');
  });

  it('the SHOPIFY scheduled set drives the 4 never-before-scheduled resources and EXCLUDES orders', () => {
    expect([...SHOPIFY_SCHEDULED_BACKFILL_RESOURCES].sort()).toEqual(
      ['customers', 'fulfillments', 'products', 'refunds'],
    );
    // Orders are owned by the live shopify-repull lane (uuidV5FromOrderLive) + the bespoke backfill
    // queue (uuidV5FromOrderBackfill); a third framework namespace would double-count in Bronze.
    expect(SHOPIFY_SCHEDULED_BACKFILL_RESOURCES).not.toContain('orders');
    // Every scheduled resource must be a REAL backfill-supported Shopify manifest resource
    // (getResource throws on a typo — a rename here would orphan cursors silently otherwise).
    for (const r of SHOPIFY_SCHEDULED_BACKFILL_RESOURCES) {
      const descriptor = getResource(SHOPIFY_MANIFEST, r);
      expect(descriptor.backfillSupported).toBe(true);
      expect(descriptor.kind).toBe('rest');
    }
  });
});

describe('requested backfill depth (0127) — parseRequestedWindowMs', () => {
  const MO = 30 * 24 * 60 * 60 * 1000;

  it('parses a valid BIGINT-as-string window', () => {
    expect(parseRequestedWindowMs(String(6 * MO))).toBe(6 * MO);
  });

  const degradeCases: ReadonlyArray<readonly [string | null | undefined, string]> = [
    [null, 'NULL column (provider max — pre-0127 rows)'],
    [undefined, 'absent'],
    ['', 'empty string'],
    ['0', 'zero'],
    ['-100', 'negative'],
    ['abc', 'non-numeric'],
    ['9007199254740993', 'beyond MAX_SAFE_INTEGER'],
  ];
  it.each(degradeCases)('degrades %s (%s) to undefined = provider max (fail-open, never zero-out a backfill)', (raw) => {
    expect(parseRequestedWindowMs(raw)).toBeUndefined();
  });
});

describe('ingestion framework — resumable / chunked', () => {
  it('pauses at the chunk budget then RESUMES from the persisted cursor (no restart)', async () => {
    const resource = getResource(SHOPIFY_MANIFEST, 'products');
    const products = makeProducts(6);
    const fetcher = fakeProductFetcher(products, 2); // 2 records/page → 3 pages total
    const sink = memSink();
    const dlq = memDlq();
    const repo = memRepo();
    const wide = 365 * 24 * 60 * 60 * 1000 * 5;

    // Run 1: only 1 chunk (1 page = 2 records) → paused.
    const r1 = await runResumableBackfill({
      brandId: BRAND, connectorInstanceId: CONNECTOR, provider: 'shopify', resource,
      fetcher, sink, dlq, stateRepo: repo, requestedWindowMs: wide, maxChunksThisRun: 1,
      idFactory: () => 'state-resume',
    });
    expect(r1.stopReason).toBe('paused');
    expect(sink.delivered).toHaveLength(2);
    const persisted = repo.store.get(`${BRAND}|${CONNECTOR}|products`)!;
    expect(persisted.status).toBe('paused');
    expect(persisted.cursor).not.toBeNull();

    // Run 2: resume to completion. It MUST continue from the cursor, not restart from page 1.
    const r2 = await runResumableBackfill({
      brandId: BRAND, connectorInstanceId: CONNECTOR, provider: 'shopify', resource,
      fetcher, sink, dlq, stateRepo: repo, requestedWindowMs: wide,
    });
    expect(r2.stopReason).toBe('completed');
    // 2 (run1) + 4 (run2) = 6 total, each unique.
    expect(sink.delivered).toHaveLength(6);
    expect(new Set(sink.delivered).size).toBe(6);
  });
});

describe('ingestion framework — strict dedup + no loss', () => {
  it('re-running an overlapping window re-derives the SAME deterministic event_ids (Bronze dedups)', async () => {
    const resource = getResource(SHOPIFY_MANIFEST, 'products');
    const products = makeProducts(4);
    const wide = 365 * 24 * 60 * 60 * 1000 * 5;

    // First full backfill.
    const sink1 = memSink();
    const repo1 = memRepo();
    await runResumableBackfill({
      brandId: BRAND, connectorInstanceId: CONNECTOR, provider: 'shopify', resource,
      fetcher: fakeProductFetcher(products, 2), sink: sink1, dlq: memDlq(), stateRepo: repo1,
      requestedWindowMs: wide, idFactory: () => 's1',
    });

    // A SECOND independent backfill of the same products (simulating an overlapping replay) — same
    // brand/connector/resource/state → byte-identical ids. Compute the expected ids directly too.
    const sink2 = memSink();
    await runResumableBackfill({
      brandId: BRAND, connectorInstanceId: CONNECTOR, provider: 'shopify', resource,
      fetcher: fakeProductFetcher(products, 2), sink: sink2, dlq: memDlq(), stateRepo: memRepo(),
      requestedWindowMs: wide, idFactory: () => 's2',
    });

    expect(sink1.delivered.sort()).toEqual(sink2.delivered.sort());

    // And the ids match the deriver applied to the manifest dedup strategy directly.
    const expected = products.map((p) => {
      const m = mapProductToDraft(p, BRAND);
      return deterministicDedupKeyDeriver.deriveEventId({
        brandId: BRAND,
        provider: 'shopify',
        resource,
        providerId: m.providerId,
        eventName: m.events[0]!.event_name,
      });
    });
    expect(sink1.delivered.sort()).toEqual(expected.sort());
  });

  it('spools EVERY event to the DLQ when the sink always fails (no event is lost)', async () => {
    const resource = getResource(SHOPIFY_MANIFEST, 'products');
    const alwaysFails: IEventSink = {
      async deliver() {
        throw new Error('broker down');
      },
    };
    const dlq = memDlq();
    const result = await runResumableBackfill({
      brandId: BRAND, connectorInstanceId: CONNECTOR, provider: 'shopify', resource,
      fetcher: fakeProductFetcher(makeProducts(3), 3), sink: alwaysFails, dlq, stateRepo: memRepo(),
      requestedWindowMs: 365 * 24 * 60 * 60 * 1000 * 5, idFactory: () => 'fail',
      // Tight retry so the test is fast — still proves "retry then DLQ, never drop".
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    expect(result.spooledToDlq).toBe(3);
    expect(dlq.spooled).toHaveLength(3);
    // each spooled record carries the deterministic id (replay stays idempotent)
    expect(dlq.spooled.every((r) => typeof r.eventId === 'string' && r.eventId.length > 0)).toBe(true);
  });
});

// ── §6.4 lane-isolation assertions ────────────────────────────────────────────────────────────────
// These tests MUST fail if the producer topic is ever re-pointed to the live collector topic.
// The backfill topic is landed by the Kafka Connect collector sink (ADR-0015 WS2); routing
// backfill events to the live topic would contaminate the live lane (ADR-BF-7).
describe('§6.4 lane isolation — ingestion-backfill emits to BACKFILL topic, never LIVE', () => {
  it('BACKFILL_TOPIC is derived from ORDER_BACKFILL_V1_TOPIC_SUFFIX (backfill lane)', () => {
    expect(BACKFILL_TOPIC).toContain(ORDER_BACKFILL_V1_TOPIC_SUFFIX);
  });

  it('BACKFILL_TOPIC does NOT contain COLLECTOR_EVENT_V1_TOPIC_SUFFIX (live lane excluded)', () => {
    expect(BACKFILL_TOPIC).not.toContain(COLLECTOR_EVENT_V1_TOPIC_SUFFIX);
  });

  it('BACKFILL_TOPIC is prefixed with the NODE_ENV-derived env segment (topic namespace)', () => {
    // In test/dev NODE_ENV, ENV resolves to "dev". Validates the full derived topic shape.
    const expectedEnv = process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
    expect(BACKFILL_TOPIC).toBe(`${expectedEnv}.${ORDER_BACKFILL_V1_TOPIC_SUFFIX}`);
  });

  it('KafkaEventSink sends to the BACKFILL topic when constructed with BACKFILL_TOPIC', async () => {
    const sent: Array<{ topic: string }> = [];
    const fakeProducer = {
      send: vi.fn(async (args: { topic: string; messages: unknown[] }) => {
        sent.push({ topic: args.topic });
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new KafkaEventSink(fakeProducer as any, BACKFILL_TOPIC, 'ingest:shopify:products:ci-1');
    await sink.deliver({
      event_name: 'product.upsert.v1',
      occurred_at: '2026-06-01T10:00:00.000Z',
      provenance: { brand_id: BRAND, source: 'shopify', event_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      properties: {},
    });
    expect(sent[0]!.topic).toBe(BACKFILL_TOPIC);
    expect(sent[0]!.topic).toContain(ORDER_BACKFILL_V1_TOPIC_SUFFIX);
    expect(sent[0]!.topic).not.toContain(COLLECTOR_EVENT_V1_TOPIC_SUFFIX);
  });
});

describe('runtime sinks', () => {
  it('KafkaEventSink projects a CanonicalEvent into a valid CollectorEventV1 envelope', async () => {
    const sent: Array<{ topic: string; messages: Array<{ value: Buffer }> }> = [];
    const fakeProducer = {
      send: vi.fn(async (args: { topic: string; messages: Array<{ value: Buffer }> }) => {
        sent.push(args);
      }),
    };
    // Use BACKFILL_TOPIC (the correct ingestion-backfill target — lane isolation §6.4)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new KafkaEventSink(fakeProducer as any, BACKFILL_TOPIC, 'ingest:test');
    const event: CanonicalEvent = {
      event_name: 'product.upsert.v1',
      occurred_at: '2026-06-01T10:00:00.000Z',
      provenance: { brand_id: BRAND, source: 'shopify', event_id: '33333333-3333-3333-3333-333333333333' },
      properties: { product_id: '900' },
    };
    await sink.deliver(event);
    expect(fakeProducer.send).toHaveBeenCalledOnce();
    const payload = JSON.parse(sent[0]!.messages[0]!.value.toString()) as Record<string, unknown>;
    expect(payload['event_id']).toBe('33333333-3333-3333-3333-333333333333');
    expect(payload['brand_id']).toBe(BRAND);
    expect(payload['event_name']).toBe('product.upsert.v1');
  });

  it('KafkaEventSink propagates a producer failure (so NoLoss retries engage)', async () => {
    const fakeProducer = { send: vi.fn(async () => { throw new Error('produce failed'); }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new KafkaEventSink(fakeProducer as any, BACKFILL_TOPIC, 'ingest:test');
    const event: CanonicalEvent = {
      event_name: 'product.upsert.v1',
      occurred_at: '2026-06-01T10:00:00.000Z',
      provenance: { brand_id: BRAND, source: 'shopify', event_id: '44444444-4444-4444-4444-444444444444' },
      properties: {},
    };
    await expect(sink.deliver(event)).rejects.toThrow('produce failed');
  });

  it('PgDeadLetterSink persists with a stable per-event address (idempotent re-spool)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeRepo = { persist: vi.fn(async (input: Record<string, unknown>) => { calls.push(input); return { inserted: true, dlqId: 'x' }; }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new PgDeadLetterSink(fakeRepo as any, 'dev');
    const record: DeadLetterRecord = {
      brandId: BRAND,
      provider: 'shopify',
      resource: 'products',
      eventId: 'evt-stable-1',
      event: {
        event_name: 'product.upsert.v1',
        occurred_at: '2026-06-01T10:00:00.000Z',
        provenance: { brand_id: BRAND, source: 'shopify', event_id: 'evt-stable-1' },
        properties: {},
      },
      failureReason: 'broker down',
      attempts: 5,
      spooledAt: new Date(),
    };
    await sink.spool(record);
    await sink.spool(record); // same event → same synthesized (topic, partition, offset)
    expect(fakeRepo.persist).toHaveBeenCalledTimes(2);
    expect(calls[0]!['sourceTopic']).toBe(frameworkDlqTopic('dev', 'shopify', 'products'));
    expect(calls[0]!['kafkaOffset']).toEqual(calls[1]!['kafkaOffset']); // stable address → dedups
    expect(calls[0]!['brandId']).toBe(BRAND);
  });

  it('PgDeadLetterSink propagates a persist failure (loud, not lost)', async () => {
    const fakeRepo = { persist: vi.fn(async () => { throw new Error('pg down'); }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = new PgDeadLetterSink(fakeRepo as any, 'dev');
    const record: DeadLetterRecord = {
      brandId: BRAND, provider: 'shopify', resource: 'products', eventId: 'e',
      event: { event_name: 'product.upsert.v1', occurred_at: '2026-06-01T10:00:00.000Z', provenance: { brand_id: BRAND, source: 'shopify', event_id: 'e' }, properties: {} },
      failureReason: 'x', attempts: 5, spooledAt: new Date(),
    };
    await expect(sink.spool(record)).rejects.toThrow('pg down');
  });
});
