/**
 * kafka-producer.test.ts — focused unit tests for CollectorKafkaProducer batch produce
 * (AUD-PERF-002) + partition-key construction (T-2).
 *
 * The partition key is `brand_id:event_id` (brand-routed — the tenant key IS the partition key,
 * so a brand's events land on a stable partition and never interleave across tenants). The ids
 * arrive as SQL projections off the spool (AUD-PERF-012): null means absent-or-non-string in the
 * raw body, and the producer falls back to the literal 'unknown' for each. The message value is
 * the canonical jsonb TEXT from the spool, sent verbatim (no re-stringify).
 *
 * kafkajs is mocked so no broker is needed; we capture the messages actually sent and the
 * real @brain/events buildPartitionKey runs (the construction under test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every send() payload so we can assert keys/values/headers per send.
const sentMessages: Array<{ key: string; value: string; headers: Record<string, string> }> = [];

const fakeProducer = {
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  send: vi.fn(
    async (args: { messages: Array<{ key: string; value: string; headers: Record<string, string> }> }) => {
      for (const m of args.messages) sentMessages.push({ key: m.key, value: m.value, headers: m.headers });
    },
  ),
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
import { CollectorKafkaProducer, type DrainMessage } from './kafka-producer.js';

function newProducer(): CollectorKafkaProducer {
  return new CollectorKafkaProducer({
    brokers: ['localhost:9092'],
    clientId: 'test',
    topic: 'test.collector.event.v1',
  });
}

function msg(overrides: Partial<DrainMessage> = {}): DrainMessage {
  return {
    valueText: '{"event_name":"page.viewed"}',
    brandId: 'brand-123',
    eventId: 'evt-abc',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('CollectorKafkaProducer partition key', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    fakeProducer.send.mockClear();
  });

  it('builds key as `brand_id:event_id` from the projected ids', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([msg()]);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.key).toBe('brand-123:evt-abc');
  });

  it('falls back to "unknown" for a null brand_id (absent/non-string in the raw body)', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([msg({ brandId: null })]);
    expect(sentMessages[0]!.key).toBe('unknown:evt-abc');
  });

  it('falls back to "unknown" for a null event_id', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([msg({ eventId: null })]);
    expect(sentMessages[0]!.key).toBe('brand-123:unknown');
  });

  it('falls back to "unknown:unknown" when both are null', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([msg({ brandId: null, eventId: null })]);
    expect(sentMessages[0]!.key).toBe('unknown:unknown');
  });

  it('treats an empty-string brand_id as a literal empty segment (string passes through)', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([msg({ brandId: '', eventId: 'evt-x' })]);
    expect(sentMessages[0]!.key).toBe(':evt-x');
  });

  it('carries the correlation_id header alongside the partition key', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([msg({ correlationId: 'corr-7' })]);
    expect(sentMessages[0]!.headers['correlation_id']).toBe('corr-7');
    expect(sentMessages[0]!.headers['source']).toBe('collector-drainer');
  });
});

describe('CollectorKafkaProducer.produceBatch (AUD-PERF-002 / AUD-PERF-012)', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    fakeProducer.send.mockClear();
  });

  it('sends a whole batch in ONE producer.send with per-message keys + correlation headers', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([
      msg({ brandId: 'b1', eventId: 'e1', correlationId: 'c1' }),
      msg({ brandId: 'b2', eventId: 'e2', correlationId: 'c2' }),
      msg({ brandId: 'b1', eventId: 'e3', correlationId: 'c3' }),
    ]);
    expect(fakeProducer.send).toHaveBeenCalledTimes(1); // one broker round-trip per drain batch
    expect(sentMessages.map((m) => m.key)).toEqual(['b1:e1', 'b2:e2', 'b1:e3']);
    expect(sentMessages.map((m) => m.headers['correlation_id'])).toEqual(['c1', 'c2', 'c3']);
  });

  it('passes the spool jsonb text through as the message value VERBATIM (no re-stringify)', async () => {
    const p = newProducer();
    await p.connect();
    const canonical = '{"brand_id": "b", "event_id": "e", "n": 1}'; // jsonb canonical spacing
    await p.produceBatch([msg({ valueText: canonical })]);
    expect(sentMessages[0]!.value).toBe(canonical);
  });

  it('an empty batch is a no-op (no send)', async () => {
    const p = newProducer();
    await p.connect();
    await p.produceBatch([]);
    expect(fakeProducer.send).not.toHaveBeenCalled();
  });

  it('throws (and sends nothing) when the producer is not connected (whole batch stays pending)', async () => {
    const p = newProducer();
    await expect(p.produceBatch([msg()])).rejects.toThrow(/producer not connected/);
    expect(sentMessages).toHaveLength(0);
  });
});
