/**
 * kafka-producer.test.ts — focused unit tests for CollectorKafkaProducer partition-key
 * construction (T-2).
 *
 * The partition key is `brand_id:event_id` (brand-routed — the tenant key IS the partition key,
 * so a brand's events land on a stable partition and never interleave across tenants). When the
 * raw body has not been validated yet, brand_id/event_id may be absent or non-string; the producer
 * falls back to the literal 'unknown' for each. These cases pin the key shape + the fallback edges.
 *
 * kafkajs is mocked so no broker is needed; we capture the `messages[].key` actually sent and the
 * real @brain/events buildPartitionKey runs (the construction under test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every send() payload so we can assert the partition key.
const sentMessages: Array<{ key: string; headers: Record<string, string> }> = [];

const fakeProducer = {
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  send: vi.fn(async (args: { messages: Array<{ key: string; headers: Record<string, string> }> }) => {
    for (const m of args.messages) sentMessages.push({ key: m.key, headers: m.headers });
  }),
};

vi.mock('kafkajs', () => ({
  Kafka: class {
    producer() {
      return fakeProducer;
    }
  },
  CompressionTypes: { None: 0, GZIP: 1 },
}));

// Keep trace-context injection a no-op (not under test here).
vi.mock('@brain/observability', () => ({
  injectKafkaTraceContext: () => undefined,
}));

// NB: @brain/events is NOT mocked — the real buildPartitionKey is the unit under test.
import { CollectorKafkaProducer } from './kafka-producer.js';

function newProducer(): CollectorKafkaProducer {
  return new CollectorKafkaProducer({
    brokers: ['localhost:9092'],
    clientId: 'test',
    topic: 'test.collector.event.v1',
  });
}

describe('CollectorKafkaProducer partition key', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    fakeProducer.send.mockClear();
  });

  it('builds key as `brand_id:event_id` from a well-formed body', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce({ brand_id: 'brand-123', event_id: 'evt-abc' }, 'corr-1');
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.key).toBe('brand-123:evt-abc');
  });

  it('falls back to "unknown" for a missing brand_id', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce({ event_id: 'evt-abc' }, 'corr-2');
    expect(sentMessages[0]!.key).toBe('unknown:evt-abc');
  });

  it('falls back to "unknown" for a missing event_id', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce({ brand_id: 'brand-123' }, 'corr-3');
    expect(sentMessages[0]!.key).toBe('brand-123:unknown');
  });

  it('falls back to "unknown:unknown" when both are missing', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce({}, 'corr-4');
    expect(sentMessages[0]!.key).toBe('unknown:unknown');
  });

  it('falls back to "unknown" for non-string brand_id / event_id (pre-validation)', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce({ brand_id: 42, event_id: { nested: true } }, 'corr-5');
    expect(sentMessages[0]!.key).toBe('unknown:unknown');
  });

  it('treats an empty-string brand_id as a literal empty segment (string passes the type guard)', async () => {
    const p = newProducer();
    await p.connect();
    // '' is a string → the guard accepts it; key carries the empty segment verbatim.
    await p.produce({ brand_id: '', event_id: 'evt-x' }, 'corr-6');
    expect(sentMessages[0]!.key).toBe(':evt-x');
  });

  it('carries the correlation_id header alongside the partition key', async () => {
    const p = newProducer();
    await p.connect();
    await p.produce({ brand_id: 'b', event_id: 'e' }, 'corr-7');
    expect(sentMessages[0]!.headers['correlation_id']).toBe('corr-7');
    expect(sentMessages[0]!.headers['source']).toBe('collector-drainer');
  });

  it('throws (and sends nothing) when the producer is not connected', async () => {
    const p = newProducer();
    await expect(p.produce({ brand_id: 'b', event_id: 'e' }, 'corr-8')).rejects.toThrow(
      /producer not connected/,
    );
    expect(sentMessages).toHaveLength(0);
  });
});

describe('CollectorKafkaProducer.produceBatch (AUD-PERF-002)', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    fakeProducer.send.mockClear();
  });

  it('sends a whole batch in ONE producer.send with per-message keys + correlation headers', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([
      { rawBody: { brand_id: 'b1', event_id: 'e1' }, correlationId: 'c1' },
      { rawBody: { brand_id: 'b2', event_id: 'e2' }, correlationId: 'c2' },
      { rawBody: { brand_id: 'b1', event_id: 'e3' }, correlationId: 'c3' },
    ]);
    expect(fakeProducer.send).toHaveBeenCalledTimes(1); // one broker round-trip per drain batch
    expect(sentMessages.map((m) => m.key)).toEqual(['b1:e1', 'b2:e2', 'b1:e3']);
    expect(sentMessages.map((m) => m.headers['correlation_id'])).toEqual(['c1', 'c2', 'c3']);
  });

  it('an empty batch is a no-op (no send)', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([]);
    expect(fakeProducer.send).not.toHaveBeenCalled();
  });

  it('throws when the producer is not connected (whole batch stays pending)', async () => {
    const p = newProducer();
    await expect(
      p.produceBatch([{ rawBody: { brand_id: 'b', event_id: 'e' }, correlationId: 'c' }]),
    ).rejects.toThrow(/producer not connected/);
  });
});
