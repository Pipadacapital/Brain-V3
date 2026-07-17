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
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@brain/observability', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: function () { return this; },
  }),
}));

import { LocalDiskFallback, FallbackSaturatedError, type FlushProducer } from './local-disk-fallback.js';
import type { ProduceMessage } from './kafka-producer.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'collector-fallback-test-'));
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

function newFallback(producer: FlushProducer, maxBytes = 1024 * 1024): LocalDiskFallback {
  return new LocalDiskFallback({ dir, maxBytes, flushIntervalMs: 60_000 }, producer);
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
