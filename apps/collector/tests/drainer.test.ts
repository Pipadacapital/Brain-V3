/**
 * drainer.test.ts — drain-loop reentrancy guard (AUD-PERF-006).
 *
 * A tick slower than pollIntervalMs must NOT overlap the next: setInterval keeps firing while a
 * slow drain (Kafka stall, big batch) is in flight; without the inTick guard two ticks would
 * poll the same pending rows and double-produce them.
 */
import { describe, it, expect } from 'vitest';
import { Drainer } from '../src/interfaces/jobs/drainer.js';
import type { DrainEventsUseCase } from '../src/application/drain-events.usecase.js';
import type { CollectorKafkaProducer } from '../src/infrastructure/kafka-producer.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fakeProducer(): CollectorKafkaProducer {
  return {
    connect: async () => {},
    disconnect: async () => {},
  } as unknown as CollectorKafkaProducer;
}

describe('Drainer — in-flight tick guard (AUD-PERF-006)', () => {
  it('never runs two drains concurrently even when a tick outlives the poll interval', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const slowUseCase = {
      execute: async () => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(60); // 6x the poll interval — guarantees interval fires mid-drain
        inFlight -= 1;
        return 0;
      },
    } as unknown as DrainEventsUseCase;

    const drainer = new Drainer(slowUseCase, fakeProducer(), { pollIntervalMs: 10, batchSize: 10 });
    await drainer.start();
    await sleep(150);
    await drainer.stop();

    expect(calls).toBeGreaterThanOrEqual(2); // the loop kept ticking
    expect(maxInFlight).toBe(1); // but drains never overlapped
  });

  it('keeps ticking after a drain error (loop never crashes)', async () => {
    let calls = 0;
    const failingUseCase = {
      execute: async () => {
        calls += 1;
        throw new Error('boom');
      },
    } as unknown as DrainEventsUseCase;

    const drainer = new Drainer(failingUseCase, fakeProducer(), { pollIntervalMs: 10, batchSize: 10 });
    await drainer.start();
    await sleep(50);
    await drainer.stop();

    expect(calls).toBeGreaterThanOrEqual(2); // error did not stop the loop (and inTick was released)
  });
});
