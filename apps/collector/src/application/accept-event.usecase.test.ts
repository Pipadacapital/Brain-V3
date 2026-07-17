/**
 * accept-event.usecase.test.ts — ADR-0015 direct-to-log accept path:
 *   • produce-on-accept (stamped envelope, serialized once, _received_at carried)
 *   • produce failure → WAL append (fallback IS the durability anchor, ACK still fires)
 *   • WAL saturated + produce failing → FallbackSaturatedError propagates (503 upstream)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@brain/observability', () => ({
  incrementCounter: () => undefined,
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: function () { return this; },
  }),
}));

import { AcceptEventUseCase } from './accept-event.usecase.js';
import type { CollectorKafkaProducer, ProduceMessage } from '../infrastructure/kafka-producer.js';
import { FallbackSaturatedError, type LocalDiskFallback } from '../infrastructure/local-disk-fallback.js';

function stubProducer(opts: { connected?: boolean; failProduce?: boolean } = {}): {
  producer: CollectorKafkaProducer;
  produced: ProduceMessage[][];
} {
  const produced: ProduceMessage[][] = [];
  const producer = {
    isConnected: () => opts.connected ?? true,
    connect: async () => undefined,
    produce: async () => undefined,
    produceBatch: async (batch: ProduceMessage[]) => {
      if (opts.failProduce) throw new Error('broker down');
      produced.push(batch);
    },
  } as unknown as CollectorKafkaProducer;
  return { producer, produced };
}

function stubFallback(opts: { saturated?: boolean } = {}): {
  fallback: LocalDiskFallback;
  appended: ProduceMessage[][];
} {
  const appended: ProduceMessage[][] = [];
  const fallback = {
    append: async (batch: ProduceMessage[]) => {
      if (opts.saturated) throw new FallbackSaturatedError(100, 100);
      appended.push(batch);
    },
    isSaturated: () => opts.saturated ?? false,
    pendingBytes: () => 0,
  } as unknown as LocalDiskFallback;
  return { fallback, appended };
}

describe('AcceptEventUseCase — produce on accept (ADR-0015 D1)', () => {
  it('produces the stamped envelope with projected ids and returns durability=produced', async () => {
    const { producer, produced } = stubProducer();
    const { fallback, appended } = stubFallback();
    const uc = new AcceptEventUseCase(producer, fallback);

    const result = await uc.execute(
      { brand_id: 'b-1', event_id: 'e-1', event_name: 'page.viewed' },
      'corr-req',
    );

    expect(result.durability).toBe('produced');
    expect(result.receivedAt).toBeTruthy();
    expect(appended).toHaveLength(0);
    expect(produced).toHaveLength(1);
    const [message] = produced[0]!;
    expect(message!.brandId).toBe('b-1');
    expect(message!.eventId).toBe('e-1');
    expect(message!.correlationId).toBe('corr-req'); // no body correlation_id → header's wins
    // The value is the stamped envelope: raw body + _received_at (the ONLY pre-produce transform).
    const value = JSON.parse(message!.valueText) as Record<string, unknown>;
    expect(value['event_name']).toBe('page.viewed');
    expect(value['_received_at']).toBe(result.receivedAt);
  });

  it('prefers the body correlation_id over the request header one (old spool projection parity)', async () => {
    const { producer, produced } = stubProducer();
    const { fallback } = stubFallback();
    const uc = new AcceptEventUseCase(producer, fallback);
    await uc.execute({ correlation_id: 'corr-body' }, 'corr-req');
    expect(produced[0]![0]!.correlationId).toBe('corr-body');
  });

  it('executeMany anchors the whole batch in ONE produceBatch', async () => {
    const { producer, produced } = stubProducer();
    const { fallback } = stubFallback();
    const uc = new AcceptEventUseCase(producer, fallback);
    const result = await uc.executeMany([{ n: 1 }, { n: 2 }, { n: 3 }], 'corr-req');
    expect(result.accepted).toBe(3);
    expect(result.durability).toBe('produced');
    expect(produced).toHaveLength(1);
    expect(produced[0]).toHaveLength(3);
  });
});

describe('AcceptEventUseCase — disk fallback (log down)', () => {
  it('falls back to the WAL on produce failure and returns durability=fallback (ACK still fires)', async () => {
    const { producer } = stubProducer({ failProduce: true });
    const { fallback, appended } = stubFallback();
    const uc = new AcceptEventUseCase(producer, fallback);
    const result = await uc.execute({ brand_id: 'b-1' }, 'corr-req');
    expect(result.durability).toBe('fallback');
    expect(appended).toHaveLength(1);
    expect(appended[0]![0]!.brandId).toBe('b-1');
  });

  it('propagates FallbackSaturatedError when produce fails AND the WAL is at cap (→ 503)', async () => {
    const { producer } = stubProducer({ failProduce: true });
    const { fallback } = stubFallback({ saturated: true });
    const uc = new AcceptEventUseCase(producer, fallback);
    await expect(uc.execute({}, 'corr-req')).rejects.toBeInstanceOf(FallbackSaturatedError);
  });
});
