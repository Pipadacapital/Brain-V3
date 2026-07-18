/**
 * kafka-producer.test.ts — unit tests for the ADR-0015 direct-to-log hot-path producer:
 * idempotent config (idempotent + acks=-1), brand_id partition key (no key when absent),
 * one send per batch, and the AUD-PERF-005 skip-fast headers.
 *
 * kafkajs is mocked so no broker is needed; we capture the producer() options and every
 * send() payload actually built.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture client + producer construction options and every send() payload.
const kafkaConfigs: Array<Record<string, unknown>> = [];
const producerOptions: Array<Record<string, unknown>> = [];
const sends: Array<{ acks?: number; compression?: number; messages: Array<{ key?: string; value: string; headers: Record<string, string> }> }> = [];
/** Instrumentation listeners registered via producer.on() — tests fire them directly. */
const eventListeners = new Map<string, Array<() => void>>();

const fakeProducer = {
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  events: { CONNECT: 'producer.connect', DISCONNECT: 'producer.disconnect' },
  on: vi.fn((event: string, cb: () => void) => {
    const list = eventListeners.get(event) ?? [];
    list.push(cb);
    eventListeners.set(event, list);
  }),
  send: vi.fn(
    async (args: { acks?: number; messages: Array<{ key?: string; value: string; headers: Record<string, string> }> }) => {
      sends.push(args);
    },
  ),
};

function fireProducerEvent(event: string): void {
  for (const cb of eventListeners.get(event) ?? []) cb();
}

vi.mock('kafkajs', () => ({
  Kafka: class {
    constructor(cfg: Record<string, unknown>) {
      kafkaConfigs.push(cfg);
    }
    producer(opts: Record<string, unknown>) {
      producerOptions.push(opts);
      return fakeProducer;
    }
  },
  CompressionTypes: { None: 0, GZIP: 1 },
}));

// Keep trace-context injection a no-op (not under test here).
vi.mock('@brain/observability', () => ({
  injectKafkaTraceContext: () => undefined,
}));

import {
  CollectorKafkaProducer,
  ProduceDeadlineError,
  type KafkaProducerConfig,
  type ProduceMessage,
} from './kafka-producer.js';

function newProducer(overrides: Partial<KafkaProducerConfig> = {}): CollectorKafkaProducer {
  return new CollectorKafkaProducer({
    brokers: ['localhost:9092'],
    clientId: 'test',
    topic: 'test.collector.event.v1',
    ...overrides,
  });
}

function msg(overrides: Partial<ProduceMessage> = {}): ProduceMessage {
  return {
    valueText: '{"event_name":"page.viewed"}',
    brandId: 'brand-123',
    eventId: 'evt-abc',
    correlationId: 'corr-1',
    ...overrides,
  };
}

function sentMessages(): Array<{ key?: string; value: string; headers: Record<string, string> }> {
  return sends.flatMap((s) => s.messages);
}

beforeEach(() => {
  kafkaConfigs.length = 0;
  producerOptions.length = 0;
  sends.length = 0;
  eventListeners.clear();
  fakeProducer.send.mockClear();
  fakeProducer.send.mockImplementation(
    async (args: { acks?: number; messages: Array<{ key?: string; value: string; headers: Record<string, string> }> }) => {
      sends.push(args);
    },
  );
  fakeProducer.connect.mockClear();
  fakeProducer.on.mockClear();
});

describe('CollectorKafkaProducer idempotent hot-path config (ADR-0015 D1/D2a)', () => {
  it('constructs an idempotent producer with one in-flight request', async () => {
    const p = newProducer();
    await p.connect();
    expect(producerOptions[0]).toMatchObject({ idempotent: true, maxInFlightRequests: 1 });
  });

  it('sends with acks=-1 (produce-ack from all ISRs is the durability anchor)', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce(msg());
    expect(sends[0]!.acks).toBe(-1);
  });

  it('connect() is single-flight and a second call after success is a no-op', async () => {
    const p = newProducer();
    await Promise.all([p.connect(), p.connect()]);
    await p.connect();
    expect(fakeProducer.connect).toHaveBeenCalledTimes(1);
    expect(p.isConnected()).toBe(true);
  });

  it('compresses batches with GZIP by default (ramp lever 0: ~4x broker disk/network)', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce(msg());
    expect(sends[0]!.compression).toBe(1); // CompressionTypes.GZIP
  });

  it("compression: 'none' is the escape hatch — sends uncompressed", async () => {
    const p = newProducer({ compression: 'none' });
    await p.connect();
    await p.produce(msg());
    expect(sends[0]!.compression).toBe(0); // CompressionTypes.None
  });
});

describe('CollectorKafkaProducer partition key (ADR-0015: key = brand_id)', () => {
  it('keys the message by brand_id (tenant-routed partitioning)', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce(msg());
    expect(sentMessages()[0]!.key).toBe('brand-123');
  });

  it('sends NO key when brand_id is absent (pre-validation malformed tail → round-robin)', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce(msg({ brandId: null }));
    expect(sentMessages()[0]!.key).toBeUndefined();
  });

  it('carries the correlation_id + source headers alongside the key', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce(msg({ correlationId: 'corr-7' }));
    expect(sentMessages()[0]!.headers['correlation_id']).toBe('corr-7');
    expect(sentMessages()[0]!.headers['source']).toBe('collector');
  });
});

describe('CollectorKafkaProducer hot-brand composite partition key (ADR-0015 §5.3)', () => {
  const anonMsg = (anonId: string, overrides: Partial<ProduceMessage> = {}): ProduceMessage =>
    msg({
      valueText: JSON.stringify({ event_name: 'page.viewed', properties: { brain_anon_id: anonId } }),
      ...overrides,
    });

  it('empty hot-brand list (the default) keeps plain brand_id keys — zero behavior change', async () => {
    const p = newProducer(); // no hotBrandIds
    await p.connect();
    await p.produceBatch([anonMsg('anon-1'), anonMsg('anon-2', { brandId: 'brand-other' })]);
    expect(sentMessages().map((m) => m.key)).toEqual(['brand-123', 'brand-other']);
  });

  it('an UNLISTED brand keeps its plain brand_id key even when a hot list exists', async () => {
    const p = newProducer({ hotBrandIds: ['brand-hot'], hotBrandBuckets: 4 });
    await p.connect();
    await p.produce(anonMsg('anon-1')); // brand-123, not listed
    expect(sentMessages()[0]!.key).toBe('brand-123');
  });

  it('a listed hot brand gets `${brand_id}:${bucket}` with a STABLE bucket per anon_id', async () => {
    const p = newProducer({ hotBrandIds: ['brand-123'], hotBrandBuckets: 4 });
    await p.connect();
    await p.produceBatch([anonMsg('anon-stable'), anonMsg('anon-stable'), anonMsg('anon-stable')]);
    const keys = sentMessages().map((m) => m.key);
    expect(keys[0]).toMatch(/^brand-123:[0-3]$/);
    // Same anon_id → same bucket, always (per-visitor partition ordering is preserved).
    expect(new Set(keys).size).toBe(1);
  });

  it('bucket assignment is stable across producer instances (hash is process-independent)', async () => {
    const p1 = newProducer({ hotBrandIds: ['brand-123'], hotBrandBuckets: 4 });
    await p1.connect();
    await p1.produce(anonMsg('anon-xyz'));
    const key1 = sentMessages()[0]!.key;

    sends.length = 0;
    const p2 = newProducer({ hotBrandIds: ['brand-123'], hotBrandBuckets: 4 });
    await p2.connect();
    await p2.produce(anonMsg('anon-xyz'));
    expect(sentMessages()[0]!.key).toBe(key1);
  });

  it('distributes distinct anon_ids across multiple buckets', async () => {
    const p = newProducer({ hotBrandIds: ['brand-123'], hotBrandBuckets: 4 });
    await p.connect();
    await p.produceBatch(Array.from({ length: 64 }, (_, i) => anonMsg(`anon-${i}`)));
    const buckets = new Set(sentMessages().map((m) => m.key));
    for (const key of buckets) expect(key).toMatch(/^brand-123:[0-3]$/);
    expect(buckets.size).toBeGreaterThan(1); // spread, not collapsed onto one composite key
  });

  it('falls back to event_id for the bucket when the envelope carries no anon_id', async () => {
    const p = newProducer({ hotBrandIds: ['brand-123'], hotBrandBuckets: 4 });
    await p.connect();
    await p.produceBatch([
      msg({ valueText: '{"event_name":"order.created"}', eventId: 'evt-noanon' }),
      msg({ valueText: '{"event_name":"order.created"}', eventId: 'evt-noanon' }),
    ]);
    const keys = sentMessages().map((m) => m.key);
    expect(keys[0]).toMatch(/^brand-123:[0-3]$/);
    expect(new Set(keys).size).toBe(1); // same event_id → same bucket (deterministic fallback)
  });

  it('a hot brand with NO brand_id projected still sends no key (round-robin, unchanged)', async () => {
    const p = newProducer({ hotBrandIds: ['brand-123'], hotBrandBuckets: 4 });
    await p.connect();
    await p.produce(msg({ brandId: null }));
    expect(sentMessages()[0]!.key).toBeUndefined();
  });
});

describe('CollectorKafkaProducer.produceBatch', () => {
  it('sends a whole batch in ONE producer.send with per-message keys + correlation headers', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([
      msg({ brandId: 'b1', eventId: 'e1', correlationId: 'c1' }),
      msg({ brandId: 'b2', eventId: 'e2', correlationId: 'c2' }),
      msg({ brandId: 'b1', eventId: 'e3', correlationId: 'c3' }),
    ]);
    expect(fakeProducer.send).toHaveBeenCalledTimes(1); // one broker round-trip per batch
    expect(sentMessages().map((m) => m.key)).toEqual(['b1', 'b2', 'b1']);
    expect(sentMessages().map((m) => m.headers['correlation_id'])).toEqual(['c1', 'c2', 'c3']);
  });

  it('passes the serialized envelope through as the message value VERBATIM (no re-stringify)', async () => {
    const p = newProducer();
    await p.connect();
    const canonical = '{"brand_id": "b", "event_id": "e", "n": 1}';
    await p.produceBatch([msg({ valueText: canonical })]);
    expect(sentMessages()[0]!.value).toBe(canonical);
  });

  it('an empty batch is a no-op (no send)', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([]);
    expect(fakeProducer.send).not.toHaveBeenCalled();
  });

  it('throws (and sends nothing) when the producer is not connected (caller falls back to WAL)', async () => {
    const p = newProducer();
    await expect(p.produceBatch([msg()])).rejects.toThrow(/producer not connected/);
    expect(sentMessages()).toHaveLength(0);
  });
});

describe('CollectorKafkaProducer event_name / brand_id / event_id headers (AUD-PERF-005)', () => {
  it('stamps the top-level event_name (and brand_id/event_id) as Kafka headers', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce(msg({ valueText: '{"event_name": "page.viewed", "n": 1}' }));
    expect(sentMessages()[0]!.headers['event_name']).toBe('page.viewed');
    expect(sentMessages()[0]!.headers['brand_id']).toBe('brand-123');
    expect(sentMessages()[0]!.headers['event_id']).toBe('evt-abc');
  });

  it('omits the event_name header when the body is unparseable (bridges fall back to body parse)', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce(msg({ valueText: 'not-json{{' }));
    expect(sentMessages()[0]!.headers['event_name']).toBeUndefined();
  });

  it('omits the event_name header when event_name is absent or non-string', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([
      msg({ valueText: '{"foo": "bar"}' }),
      msg({ valueText: '{"event_name": 42}' }),
      msg({ valueText: '{"event_name": ""}' }),
    ]);
    for (const m of sentMessages()) expect(m.headers['event_name']).toBeUndefined();
  });

  it('uses the TOP-LEVEL event_name, never a nested payload key of the same name', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce(
      msg({ valueText: '{"payload": {"event_name": "nested.decoy"}, "event_name": "order.created"}' }),
    );
    expect(sentMessages()[0]!.headers['event_name']).toBe('order.created');
  });

  it('omits the brand_id header when brand_id is not projected (null)', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce(msg({ brandId: null }));
    expect(sentMessages()[0]!.headers['brand_id']).toBeUndefined();
    expect(sentMessages()[0]!.headers['event_name']).toBe('page.viewed');
  });
});

describe('CollectorKafkaProducer bounded request timeout (H3)', () => {
  it('sets requestTimeout on the kafkajs client (default 4000ms — never the 30s kafkajs default)', () => {
    newProducer();
    expect(kafkaConfigs[0]!['requestTimeout']).toBe(4_000);
  });

  it('honors INGEST_PRODUCE_REQUEST_TIMEOUT_MS via config', () => {
    newProducer({ requestTimeoutMs: 2_500 });
    expect(kafkaConfigs[0]!['requestTimeout']).toBe(2_500);
  });
});

describe('CollectorKafkaProducer.isHealthy — honest post-boot health (H3)', () => {
  it('is unhealthy before connect and healthy after (alongside isConnected)', async () => {
    const p = newProducer();
    expect(p.isHealthy()).toBe(false);
    await p.connect();
    expect(p.isHealthy()).toBe(true);
    expect(p.isConnected()).toBe(true);
  });

  it('flips unhealthy after 3 consecutive produce failures while isConnected() still lies true', async () => {
    const p = newProducer();
    await p.connect();
    fakeProducer.send.mockRejectedValue(new Error('broker gone'));
    for (let i = 0; i < 2; i += 1) {
      await expect(p.produce(msg())).rejects.toThrow('broker gone');
      expect(p.isHealthy()).toBe(true); // below threshold — one blip is not an outage
    }
    await expect(p.produce(msg())).rejects.toThrow('broker gone');
    expect(p.isHealthy()).toBe(false); // 3rd consecutive failure trips the bit
    expect(p.isConnected()).toBe(true); // the pre-H3 signal never flipped — the whole bug
  });

  it('auto-clears the health bit on the next successful produce', async () => {
    const p = newProducer();
    await p.connect();
    fakeProducer.send.mockRejectedValue(new Error('broker gone'));
    for (let i = 0; i < 3; i += 1) await expect(p.produce(msg())).rejects.toThrow();
    expect(p.isHealthy()).toBe(false);
    fakeProducer.send.mockImplementation(async (args) => {
      sends.push(args as (typeof sends)[number]);
    });
    await p.produce(msg());
    expect(p.isHealthy()).toBe(true);
  });

  it('a success between failures resets the consecutive counter (no slow accumulation trip)', async () => {
    const p = newProducer();
    await p.connect();
    for (let round = 0; round < 3; round += 1) {
      fakeProducer.send.mockRejectedValueOnce(new Error('blip'));
      await expect(p.produce(msg())).rejects.toThrow('blip');
      await p.produce(msg()); // success resets — 3 non-consecutive failures never trip
    }
    expect(p.isHealthy()).toBe(true);
  });

  it('DISCONNECT instrumentation event flips unhealthy; CONNECT clears it (secondary signal)', async () => {
    const p = newProducer();
    await p.connect();
    expect(p.isHealthy()).toBe(true);
    fireProducerEvent('producer.disconnect');
    expect(p.isHealthy()).toBe(false);
    expect(p.isConnected()).toBe(true);
    fireProducerEvent('producer.connect');
    expect(p.isHealthy()).toBe(true);
  });
});

describe('CollectorKafkaProducer per-produce deadline (H3)', () => {
  it('rejects with ProduceDeadlineError when the send outlives INGEST_PRODUCE_DEADLINE_MS', async () => {
    const p = newProducer({ produceDeadlineMs: 30 });
    await p.connect();
    // Broker black-hole: the send never settles — the deadline must bound the accept path
    // (the caller then routes the batch to the WAL exactly like a produce failure).
    fakeProducer.send.mockImplementation(() => new Promise<never>(() => undefined));
    await expect(p.produce(msg())).rejects.toBeInstanceOf(ProduceDeadlineError);
  });

  it('a deadline expiry counts toward the consecutive-failure health bit', async () => {
    const p = newProducer({ produceDeadlineMs: 10 });
    await p.connect();
    fakeProducer.send.mockImplementation(() => new Promise<never>(() => undefined));
    for (let i = 0; i < 3; i += 1) {
      await expect(p.produce(msg())).rejects.toBeInstanceOf(ProduceDeadlineError);
    }
    expect(p.isHealthy()).toBe(false);
  });

  it('a fast send is unaffected by the deadline', async () => {
    const p = newProducer({ produceDeadlineMs: 5_000 });
    await p.connect();
    await p.produce(msg());
    expect(sends).toHaveLength(1);
    expect(p.isHealthy()).toBe(true);
  });

  it('a late rejection from the raced-out send is absorbed (no unhandledRejection)', async () => {
    const p = newProducer({ produceDeadlineMs: 10 });
    await p.connect();
    let rejectLate: ((err: Error) => void) | undefined;
    fakeProducer.send.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectLate = reject;
        }),
    );
    await expect(p.produce(msg())).rejects.toBeInstanceOf(ProduceDeadlineError);
    rejectLate!(new Error('late broker failure'));
    // Give the microtask queue a tick — an unhandled rejection here would fail the run.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
