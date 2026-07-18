/**
 * shutdown-drain.test.ts — the SIGTERM WAL drain sequence (ADR-0015 WAL durability posture):
 *   • ORDER: final WAL flush runs BEFORE the producer disconnect (disconnect-first would make
 *     the flush a guaranteed no-op and silently widen the durability exposure window).
 *   • The bounded deadline is honored: a hanging flush yields 'timeout' and shutdown proceeds.
 *   • Every step is best-effort: a throwing step never blocks the next one.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@brain/observability', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: function () { return this; },
  }),
  incrementCounter: () => undefined,
}));

import { drainWalThenDisconnect, type DrainableWal, type DisconnectableProducer } from './shutdown-drain.js';

function harness(overrides: Partial<DrainableWal> = {}): {
  calls: string[];
  fallback: DrainableWal;
  producer: DisconnectableProducer;
} {
  const calls: string[] = [];
  const fallback: DrainableWal = {
    drain: async () => {
      calls.push('drain');
      return 'drained';
    },
    stop: async () => {
      calls.push('stop');
    },
    pendingBytes: () => 0,
    ...overrides,
  };
  const producer: DisconnectableProducer = {
    disconnect: async () => {
      calls.push('disconnect');
    },
  };
  return { calls, fallback, producer };
}

describe('drainWalThenDisconnect (SIGTERM order + bounded deadline)', () => {
  it('flushes the WAL BEFORE disconnecting the producer', async () => {
    const { calls, fallback, producer } = harness();
    await expect(drainWalThenDisconnect(fallback, producer, 1_000)).resolves.toBe('drained');
    expect(calls).toEqual(['drain', 'stop', 'disconnect']);
  });

  it('passes the configured deadline through to the WAL drain', async () => {
    const seen: number[] = [];
    const { fallback, producer } = harness({
      drain: async (timeoutMs: number) => {
        seen.push(timeoutMs);
        return 'drained';
      },
    });
    await drainWalThenDisconnect(fallback, producer, 10_000);
    expect(seen).toEqual([10_000]);
  });

  it('still stops the flusher and disconnects when the drain times out', async () => {
    const { calls, fallback, producer } = harness({
      drain: async () => {
        calls.push('drain');
        return 'timeout';
      },
    });
    await expect(drainWalThenDisconnect(fallback, producer, 10)).resolves.toBe('timeout');
    expect(calls).toEqual(['drain', 'stop', 'disconnect']);
  });

  it('a throwing drain/stop never blocks the producer disconnect (best-effort chain)', async () => {
    const { calls, fallback, producer } = harness({
      drain: async () => {
        calls.push('drain');
        throw new Error('flush exploded');
      },
      stop: async () => {
        calls.push('stop');
        throw new Error('stop exploded');
      },
    });
    await expect(drainWalThenDisconnect(fallback, producer, 10)).resolves.toBe('drained');
    expect(calls).toEqual(['drain', 'stop', 'disconnect']);
  });
});
