/**
 * produce-micro-batcher.test.ts — M1 in-process coalescing over the accept hot path:
 *   • concurrent enqueues coalesce into ONE flush (per linger window)
 *   • every enqueue resolves with ITS batch's flush outcome (ACK contract unchanged)
 *   • maxEvents triggers an immediate flush before the linger elapses
 *   • a failed flush rejects exactly that batch's waiters; the next batch is independent
 *   • buffer preserves enqueue (append) order — per-key ordering holds downstream
 */
import { describe, it, expect, vi } from 'vitest';
import { ProduceMicroBatcher } from './produce-micro-batcher.js';
import type { ProduceMessage } from './kafka-producer.js';

function msg(n: number): ProduceMessage {
  return {
    valueText: JSON.stringify({ n }),
    brandId: `brand-${n % 2}`,
    eventId: `evt-${n}`,
    correlationId: `corr-${n}`,
  };
}

function recordingFlush(): {
  flush: (m: ProduceMessage[]) => Promise<'produced'>;
  calls: ProduceMessage[][];
} {
  const calls: ProduceMessage[][] = [];
  return {
    calls,
    flush: async (m: ProduceMessage[]) => {
      calls.push(m);
      return 'produced' as const;
    },
  };
}

describe('ProduceMicroBatcher coalescing (M1)', () => {
  it('coalesces concurrent enqueues into ONE flush and resolves every waiter with its outcome', async () => {
    const { flush, calls } = recordingFlush();
    const batcher = new ProduceMicroBatcher(flush, { lingerMs: 5, maxEvents: 500 });

    const results = await Promise.all([
      batcher.enqueue([msg(1)]),
      batcher.enqueue([msg(2)]),
      batcher.enqueue([msg(3), msg(4)]), // a /batch request enqueues as one unit
    ]);

    expect(calls).toHaveLength(1); // one produceBatch for all four events
    expect(calls[0]).toHaveLength(4);
    expect(results).toEqual(['produced', 'produced', 'produced']);
  });

  it('preserves enqueue (append) order within the coalesced batch', async () => {
    const { flush, calls } = recordingFlush();
    const batcher = new ProduceMicroBatcher(flush, { lingerMs: 5, maxEvents: 500 });
    await Promise.all([batcher.enqueue([msg(1)]), batcher.enqueue([msg(2)]), batcher.enqueue([msg(3)])]);
    expect(calls[0]!.map((m) => m.eventId)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('flushes immediately at maxEvents without waiting out the linger', async () => {
    const { flush, calls } = recordingFlush();
    // Linger far beyond the test budget: only the size trigger can flush in time.
    const batcher = new ProduceMicroBatcher(flush, { lingerMs: 60_000, maxEvents: 3 });
    const results = await Promise.all([
      batcher.enqueue([msg(1)]),
      batcher.enqueue([msg(2)]),
      batcher.enqueue([msg(3)]),
    ]);
    expect(calls).toHaveLength(1);
    expect(results).toEqual(['produced', 'produced', 'produced']);
  });

  it('separate linger windows produce separate flushes', async () => {
    const { flush, calls } = recordingFlush();
    const batcher = new ProduceMicroBatcher(flush, { lingerMs: 1, maxEvents: 500 });
    await batcher.enqueue([msg(1)]);
    await batcher.enqueue([msg(2)]);
    expect(calls).toHaveLength(2);
  });

  it('a failed flush rejects EVERY waiter in that batch; the next batch is independent', async () => {
    const calls: ProduceMessage[][] = [];
    let failing = true;
    const flush = async (m: ProduceMessage[]): Promise<'produced'> => {
      calls.push(m);
      if (failing) throw new Error('anchor exhausted');
      return 'produced';
    };
    const batcher = new ProduceMicroBatcher(flush, { lingerMs: 5, maxEvents: 500 });

    const [r1, r2] = await Promise.allSettled([batcher.enqueue([msg(1)]), batcher.enqueue([msg(2)])]);
    expect(r1!.status).toBe('rejected');
    expect(r2!.status).toBe('rejected');
    expect((r1 as PromiseRejectedResult).reason).toEqual(new Error('anchor exhausted'));

    failing = false;
    await expect(batcher.enqueue([msg(3)])).resolves.toBe('produced');
    expect(calls).toHaveLength(2); // the chain survived the rejected flush
  });

  it('flushes are chained, never concurrent (cross-batch ordering preserved)', async () => {
    const order: string[] = [];
    let release!: () => void;
    const firstFlushGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const flush = async (m: ProduceMessage[]): Promise<'produced'> => {
      order.push(`start-${m[0]!.eventId}`);
      if (first) {
        first = false;
        await firstFlushGate; // hold the first flush open while the second batch queues
      }
      order.push(`end-${m[0]!.eventId}`);
      return 'produced';
    };
    const batcher = new ProduceMicroBatcher(flush, { lingerMs: 1, maxEvents: 500 });

    const p1 = batcher.enqueue([msg(1)]);
    await vi.waitFor(() => expect(order).toContain('start-evt-1'));
    const p2 = batcher.enqueue([msg(2)]); // lands in the NEXT batch while flush 1 is in flight
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start-evt-1', 'end-evt-1', 'start-evt-2', 'end-evt-2']);
  });
});
