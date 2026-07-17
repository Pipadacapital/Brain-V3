/**
 * kafka-producer.test.ts — unit tests for the ADR-0015 direct-to-log hot-path producer:
 * idempotent config (idempotent + acks=-1), brand_id partition key (no key when absent),
 * one send per batch, and the AUD-PERF-005 skip-fast headers.
 *
 * kafkajs is mocked so no broker is needed; we capture the producer() options and every
 * send() payload actually built.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture producer construction options + every send() payload.
const producerOptions: Array<Record<string, unknown>> = [];
const sends: Array<{ acks?: number; messages: Array<{ key?: string; value: string; headers: Record<string, string> }> }> = [];

const fakeProducer = {
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  send: vi.fn(
    async (args: { acks?: number; messages: Array<{ key?: string; value: string; headers: Record<string, string> }> }) => {
      sends.push(args);
    },
  ),
};

vi.mock('kafkajs', () => ({
  Kafka: class {
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

import { CollectorKafkaProducer, type ProduceMessage } from './kafka-producer.js';

function newProducer(): CollectorKafkaProducer {
  return new CollectorKafkaProducer({
    brokers: ['localhost:9092'],
    clientId: 'test',
    topic: 'test.collector.event.v1',
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
  producerOptions.length = 0;
  sends.length = 0;
  fakeProducer.send.mockClear();
  fakeProducer.connect.mockClear();
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
