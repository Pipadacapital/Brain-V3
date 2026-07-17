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
    isConnected: () => true,
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

describe('Drainer — producer connect retry (startup race, 2026-07-17)', () => {
  it('re-attempts producer.connect() each tick when startup connect lost the race, then drains', async () => {
    // Reproduces the live incident: Kafka restarted ~1 min before the collector booted, the
    // startup connect() failed, and the old drainer NEVER re-attempted connect — every spool row
    // stayed 'pending' until a process restart. The tick must now retry connect and, once it
    // succeeds, drain normally.
    let connected = false;
    let connectAttempts = 0;
    const producer = {
      connect: async () => {
        connectAttempts += 1;
        if (connectAttempts < 3) throw new Error('ECONNREFUSED 127.0.0.1:9092');
        connected = true;
      },
      disconnect: async () => {
        connected = false;
      },
      isConnected: () => connected,
    } as unknown as CollectorKafkaProducer;

    let drains = 0;
    const useCase = {
      execute: async () => {
        // The drainer must never call the use case while the producer is not connected.
        expect(connected).toBe(true);
        drains += 1;
        return 0;
      },
    } as unknown as DrainEventsUseCase;

    const drainer = new Drainer(useCase, producer, { pollIntervalMs: 10, batchSize: 10 });
    await drainer.start(); // attempt 1 fails (back-pressure mode) — loop starts anyway
    await sleep(100); // ticks: attempt 2 fails, attempt 3 succeeds, then drains
    await drainer.stop();

    expect(connectAttempts).toBeGreaterThanOrEqual(3);
    expect(drains).toBeGreaterThanOrEqual(1); // recovered WITHOUT a process restart
  });

  it('skips the drain (rows stay pending) while the producer cannot connect', async () => {
    const producer = {
      connect: async () => {
        throw new Error('broker unreachable');
      },
      disconnect: async () => {},
      isConnected: () => false,
    } as unknown as CollectorKafkaProducer;

    let drains = 0;
    const useCase = {
      execute: async () => {
        drains += 1;
        return 0;
      },
    } as unknown as DrainEventsUseCase;

    const drainer = new Drainer(useCase, producer, { pollIntervalMs: 10, batchSize: 10 });
    await drainer.start();
    await sleep(60);
    await drainer.stop().catch(() => undefined); // stop() disconnect may reject on the fake

    expect(drains).toBe(0); // back-pressure hold: no claim/rollback churn on a dead producer
  });
});
