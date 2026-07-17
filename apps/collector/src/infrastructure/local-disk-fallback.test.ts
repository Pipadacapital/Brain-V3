/**
 * local-disk-fallback.test.ts — bounded on-pod WAL (ADR-0015 D1):
 *   • append → flush re-produces the entries → file truncated (unlinked)
 *   • produce failure keeps the WAL for the next tick (at-least-once)
 *   • cap → FallbackSaturatedError (mapped to 503 by producer-backpressure)
 *   • crash recovery: init() adopts leftover bytes from a previous process
 *
 * Real filesystem (tmp dir per test), stubbed producer — no broker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const counterCalls: Array<{ name: string; labels: Record<string, string>; value: number }> = [];

vi.mock('@brain/observability', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: function () { return this; },
  }),
  incrementCounter: (name: string, labels: Record<string, string> = {}, value = 1) => {
    counterCalls.push({ name, labels, value });
  },
}));

import { LocalDiskFallback, FallbackSaturatedError, type FlushProducer } from './local-disk-fallback.js';
import type { ProduceMessage } from './kafka-producer.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'collector-fallback-test-'));
  counterCalls.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function msg(n: number): ProduceMessage {
  return {
    valueText: JSON.stringify({ event_name: 'page.viewed', n }),
    brandId: `brand-${n}`,
    eventId: `evt-${n}`,
    correlationId: `corr-${n}`,
  };
}

function stubProducer(overrides: Partial<FlushProducer> = {}): FlushProducer & { produced: ProduceMessage[] } {
  const produced: ProduceMessage[] = [];
  return {
    produced,
    isConnected: () => true,
    connect: async () => undefined,
    produceBatch: async (batch: ProduceMessage[]) => {
      produced.push(...batch);
    },
    ...overrides,
  };
}

function newFallback(
  producer: FlushProducer,
  maxBytes = 1024 * 1024,
  flushProduceBatchLines?: number,
): LocalDiskFallback {
  return new LocalDiskFallback(
    {
      dir,
      maxBytes,
      flushIntervalMs: 60_000,
      ...(flushProduceBatchLines !== undefined ? { flushProduceBatchLines } : {}),
    },
    producer,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('LocalDiskFallback append → flush → truncate', () => {
  it('appends durably, flushes every entry to the producer, and truncates the WAL', async () => {
    const producer = stubProducer();
    const wal = newFallback(producer);
    await wal.init();

    await wal.append([msg(1), msg(2)]);
    await wal.append([msg(3)]);
    expect(wal.pendingBytes()).toBeGreaterThan(0);

    await wal.flushOnce();

    expect(producer.produced.map((m) => m.eventId)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    expect(producer.produced[0]).toEqual(msg(1)); // full round-trip: value + ids + correlation
    expect(wal.pendingBytes()).toBe(0);
    expect(await exists(join(dir, 'collector-fallback.wal'))).toBe(false);
    expect(await exists(join(dir, 'collector-fallback.flushing.wal'))).toBe(false);
    await wal.stop();
  });

  it('keeps the WAL when the produce fails, then drains it on a later tick (at-least-once)', async () => {
    let failing = true;
    const producer = stubProducer({
      produceBatch: async (batch: ProduceMessage[]) => {
        if (failing) throw new Error('broker down');
        producer.produced.push(...batch);
      },
    });
    const wal = newFallback(producer);
    await wal.init();

    await wal.append([msg(1)]);
    await wal.flushOnce(); // produce fails — entry must survive
    expect(wal.pendingBytes()).toBeGreaterThan(0);

    failing = false;
    await wal.flushOnce();
    expect(producer.produced.map((m) => m.eventId)).toEqual(['evt-1']);
    expect(wal.pendingBytes()).toBe(0);
    await wal.stop();
  });

  it('skips flushing entirely while the producer is disconnected and cannot reconnect', async () => {
    const producer = stubProducer({
      isConnected: () => false,
      connect: async () => {
        throw new Error('still down');
      },
    });
    const wal = newFallback(producer);
    await wal.init();
    await wal.append([msg(1)]);
    await wal.flushOnce();
    expect(producer.produced).toHaveLength(0);
    expect(wal.pendingBytes()).toBeGreaterThan(0); // rotated but retained
    await wal.stop();
  });

  it('appends that arrive DURING a flush are preserved for the next pass (rotation safety)', async () => {
    const producer = stubProducer();
    const wal = newFallback(producer);
    await wal.init();
    await wal.append([msg(1)]);

    // Interleave: append msg(2) while the flush pass is producing msg(1).
    const origProduce = producer.produceBatch.bind(producer);
    producer.produceBatch = async (batch: ProduceMessage[]) => {
      await wal.append([msg(2)]);
      await origProduce(batch);
    };
    await wal.flushOnce();
    expect(producer.produced.map((m) => m.eventId)).toEqual(['evt-1']);
    expect(wal.pendingBytes()).toBeGreaterThan(0); // msg(2) still pending

    producer.produceBatch = origProduce;
    await wal.flushOnce();
    expect(producer.produced.map((m) => m.eventId)).toEqual(['evt-1', 'evt-2']);
    expect(wal.pendingBytes()).toBe(0);
    await wal.stop();
  });
});

describe('LocalDiskFallback cap (bounded buffer → 503 backpressure)', () => {
  it('throws FallbackSaturatedError when an append would exceed maxBytes', async () => {
    const producer = stubProducer();
    const wal = newFallback(producer, 200); // tiny cap
    await wal.init();
    await wal.append([msg(1)]); // fits
    expect(wal.isSaturated()).toBe(false);
    await expect(wal.append([msg(2), msg(3)])).rejects.toBeInstanceOf(FallbackSaturatedError);
    // The rejected batch must NOT be partially written.
    const content = await readFile(join(dir, 'collector-fallback.wal'), 'utf8');
    expect(content.trim().split('\n')).toHaveLength(1);
    await wal.stop();
  });

  it('isSaturated() flips at the cap and clears after a successful flush', async () => {
    const producer = stubProducer();
    const oneMsgBytes = Buffer.byteLength(JSON.stringify(msg(1)) + '\n');
    const wal = newFallback(producer, oneMsgBytes); // cap = exactly one entry
    await wal.init();
    await wal.append([msg(1)]);
    expect(wal.isSaturated()).toBe(true);
    await wal.flushOnce();
    expect(wal.isSaturated()).toBe(false);
    await wal.stop();
  });
});

describe('LocalDiskFallback WAL observability (ADR-0015 durability posture)', () => {
  it('walStats() gauges update on append and reset on flush', async () => {
    const producer = stubProducer();
    const wal = newFallback(producer);
    await wal.init();
    expect(wal.walStats()).toEqual({ pendingBytes: 0, pendingEvents: 0, oldestEntryAgeSeconds: 0 });

    await wal.append([msg(1), msg(2)]);
    await wal.append([msg(3)]);
    const pending = wal.walStats();
    expect(pending.pendingEvents).toBe(3);
    expect(pending.pendingBytes).toBe(wal.pendingBytes());
    expect(pending.pendingBytes).toBeGreaterThan(0);
    expect(pending.oldestEntryAgeSeconds).toBeGreaterThanOrEqual(0);

    await wal.flushOnce();
    expect(wal.walStats()).toEqual({ pendingBytes: 0, pendingEvents: 0, oldestEntryAgeSeconds: 0 });
    await wal.stop();
  });

  it('oldest-entry age tracks the FIRST unflushed entry and survives a failed flush (rotation)', async () => {
    vi.useFakeTimers();
    try {
      let failing = true;
      const producer = stubProducer({
        produceBatch: async (batch: ProduceMessage[]) => {
          if (failing) throw new Error('broker down');
          producer.produced.push(...batch);
        },
      });
      const wal = newFallback(producer);
      await wal.init();

      await wal.append([msg(1)]);
      vi.advanceTimersByTime(10_000);
      await wal.flushOnce(); // fails → entry rotated to .flushing but still pending
      expect(wal.walStats().oldestEntryAgeSeconds).toBeCloseTo(10, 0);

      // A newer append must NOT reset the age — the OLDEST entry drives the gauge.
      await wal.append([msg(2)]);
      vi.advanceTimersByTime(5_000);
      expect(wal.walStats().oldestEntryAgeSeconds).toBeCloseTo(15, 0);

      failing = false;
      await wal.flushOnce(); // drains .flushing (msg 1)
      await wal.flushOnce(); // drains rotated active (msg 2)
      expect(wal.walStats().oldestEntryAgeSeconds).toBe(0);
      await wal.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('increments collector_wal_flushed_total per drained event and flush_failures_total per failed pass', async () => {
    let failing = true;
    const producer = stubProducer({
      produceBatch: async (batch: ProduceMessage[]) => {
        if (failing) throw new Error('broker down');
        producer.produced.push(...batch);
      },
    });
    const wal = newFallback(producer);
    await wal.init();
    await wal.append([msg(1), msg(2)]);

    await wal.flushOnce(); // fails
    expect(counterCalls.filter((c) => c.name === 'collector_wal_flush_failures_total')).toHaveLength(1);
    expect(counterCalls.filter((c) => c.name === 'collector_wal_flushed_total')).toHaveLength(0);

    failing = false;
    await wal.flushOnce();
    const flushed = counterCalls.filter((c) => c.name === 'collector_wal_flushed_total');
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.value).toBe(2);
    await wal.stop();
  });

  it('init() adopts pending-event count for crash-leftover WAL files', async () => {
    const wal1 = newFallback(stubProducer());
    await wal1.init();
    await wal1.append([msg(1), msg(2), msg(3)]);
    await wal1.stop(); // "crash" — nothing flushed

    const wal2 = newFallback(stubProducer());
    await wal2.init();
    const stats = wal2.walStats();
    expect(stats.pendingEvents).toBe(3);
    expect(stats.oldestEntryAgeSeconds).toBeGreaterThanOrEqual(0);
    await wal2.stop();
  });
});

describe('LocalDiskFallback.drain (SIGTERM bounded final flush)', () => {
  it('returns drained when the final flush completes inside the deadline', async () => {
    const producer = stubProducer();
    const wal = newFallback(producer);
    await wal.init();
    await wal.append([msg(1)]);
    await expect(wal.drain(5_000)).resolves.toBe('drained');
    expect(producer.produced.map((m) => m.eventId)).toEqual(['evt-1']);
    expect(wal.pendingBytes()).toBe(0);
    await wal.stop();
  });

  it('returns timeout when the flush outlives the deadline (WAL stays on disk)', async () => {
    const producer = stubProducer({
      // Hang the produce past the deadline — a broker black-hole during shutdown.
      produceBatch: () => new Promise<void>(() => undefined),
    });
    const wal = newFallback(producer);
    await wal.init();
    await wal.append([msg(1)]);
    await expect(wal.drain(50)).resolves.toBe('timeout');
    expect(wal.pendingBytes()).toBeGreaterThan(0); // rotated, retained for next-boot adoption
  });
});

describe('LocalDiskFallback produced-line high-water offset (M4 — no whole-file replay)', () => {
  const OFFSET_FILE = 'collector-fallback.flushing.wal.offset';

  /** A producer that fails on the Nth produceBatch call (1-based), succeeds otherwise. */
  function failOnCall(n: number): FlushProducer & { produced: ProduceMessage[] } {
    const produced: ProduceMessage[] = [];
    let calls = 0;
    return {
      produced,
      isConnected: () => true,
      connect: async () => undefined,
      produceBatch: async (batch: ProduceMessage[]) => {
        calls += 1;
        if (calls === n) throw new Error('broker down mid-file');
        produced.push(...batch);
      },
    };
  }

  it('a flush retry RESUMES from the offset — produced lines are never replayed', async () => {
    // Batch = 2 lines: 5 entries → batches [1,2] [3,4] [5]; the 2nd batch produce fails.
    const producer = failOnCall(2);
    const wal = newFallback(producer, 1024 * 1024, 2);
    await wal.init();
    await wal.append([msg(1), msg(2), msg(3), msg(4), msg(5)]);

    await wal.flushOnce(); // batch [1,2] produced + offset fsync'd; batch [3,4] fails
    expect(producer.produced.map((m) => m.eventId)).toEqual(['evt-1', 'evt-2']);
    expect(await readFile(join(dir, OFFSET_FILE), 'utf8')).toBe('2'); // high-water = 2 lines
    expect(wal.walStats().pendingEvents).toBe(3); // only the unproduced tail is pending

    await wal.flushOnce(); // retry: resumes AFTER line 2 — evt-1/evt-2 must NOT re-produce
    expect(producer.produced.map((m) => m.eventId)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5']);
    expect(wal.pendingBytes()).toBe(0);
    await wal.stop();
  });

  it('crash between produce and offset-write re-produces AT MOST one batch (bounded, accepted)', async () => {
    const producer = failOnCall(2);
    const wal = newFallback(producer, 1024 * 1024, 2);
    await wal.init();
    await wal.append([msg(1), msg(2), msg(3), msg(4), msg(5)]);
    await wal.flushOnce(); // [1,2] produced, offset=2 written, [3,4] failed

    // Simulate the crash window: the batch produce landed but the offset fsync never did.
    await rm(join(dir, OFFSET_FILE));

    const retryProducer = stubProducer();
    const wal2 = newFallback(retryProducer, 1024 * 1024, 2);
    await wal2.init();
    await wal2.flushOnce();
    // ONE batch ([1,2]) re-produced — bounded to the lost offset write; keyed events are
    // absorbed by Bronze-compaction + Silver dedup downstream (ADR-0015 D2).
    expect(retryProducer.produced.map((m) => m.eventId)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5']);
    await wal2.stop();
    await wal.stop();
  });

  it('next-boot adoption resumes from the crash-leftover offset (no replay across restarts)', async () => {
    const producer1 = failOnCall(2);
    const wal1 = newFallback(producer1, 1024 * 1024, 2);
    await wal1.init();
    await wal1.append([msg(1), msg(2), msg(3), msg(4), msg(5)]);
    await wal1.flushOnce(); // [1,2] produced + offset=2; then "crash"
    await wal1.stop();

    const producer2 = stubProducer();
    const wal2 = newFallback(producer2, 1024 * 1024, 2);
    await wal2.init();
    expect(wal2.walStats().pendingEvents).toBe(3); // adoption subtracts the produced high-water
    await wal2.flushOnce();
    expect(producer2.produced.map((m) => m.eventId)).toEqual(['evt-3', 'evt-4', 'evt-5']);
    expect(wal2.pendingBytes()).toBe(0);
    await wal2.stop();
  });

  it('deletes the sidecar with the .flushing file on completion', async () => {
    const producer = failOnCall(2);
    const wal = newFallback(producer, 1024 * 1024, 2);
    await wal.init();
    await wal.append([msg(1), msg(2), msg(3)]);
    await wal.flushOnce(); // [1,2] ok + sidecar written; [3] fails
    expect(await exists(join(dir, OFFSET_FILE))).toBe(true);

    await wal.flushOnce(); // completes
    expect(await exists(join(dir, OFFSET_FILE))).toBe(false);
    expect(await exists(join(dir, 'collector-fallback.flushing.wal'))).toBe(false);
    await wal.stop();
  });

  it('a stale fileless sidecar is cleaned at init and NEVER pairs with a fresh rotation (no loss)', async () => {
    // Crash-window artifact: sidecar survived but its .flushing file is gone.
    await writeFile(join(dir, OFFSET_FILE), '2');

    const producer = stubProducer();
    const wal = newFallback(producer, 1024 * 1024, 2);
    await wal.init();
    await wal.append([msg(1), msg(2), msg(3)]);
    await wal.flushOnce();
    // All three produced — a stale offset=2 skipping unproduced lines would have LOST 1+2.
    expect(producer.produced.map((m) => m.eventId)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    await wal.stop();
  });
});

describe('LocalDiskFallback crash recovery', () => {
  it('init() adopts WAL bytes left by a previous process and the flusher drains them', async () => {
    const producer1 = stubProducer();
    const wal1 = newFallback(producer1);
    await wal1.init();
    await wal1.append([msg(1), msg(2)]);
    await wal1.stop(); // "crash" — nothing flushed

    const producer2 = stubProducer();
    const wal2 = newFallback(producer2);
    await wal2.init();
    expect(wal2.pendingBytes()).toBeGreaterThan(0);
    await wal2.flushOnce();
    expect(producer2.produced.map((m) => m.eventId)).toEqual(['evt-1', 'evt-2']);
    expect(wal2.pendingBytes()).toBe(0);
    await wal2.stop();
  });
});
