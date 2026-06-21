/**
 * bronzeBridges.test.ts — the registry-coverage guard (DB/infra-free).
 *
 * Locks the declarative Bronze-bridge registry so the set can't silently drift, and proves
 * buildBronzeBridges() returns exactly one consumer per entry — the structural property that
 * makes the main.ts start/stop loop cover every bridge (kills the "wired-to-nothing" anti-pattern).
 */
import { describe, it, expect } from 'vitest';
import type { Kafka } from 'kafkajs';
import { BRONZE_BRIDGES, buildBronzeBridges } from './bronzeBridges.js';
import type { ProcessEventUseCase } from '../../application/ProcessEventUseCase.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';

// Minimal Kafka mock — the consumer constructor only calls kafka.consumer()/kafka.producer().
const mockKafka = {
  consumer: () => ({}) as unknown,
  producer: () => ({}) as unknown,
} as unknown as Kafka;

const deps = {
  kafka: mockKafka,
  processEvent: {} as ProcessEventUseCase,
  topic: 'test.topic',
  retryCounter: {} as IRetryCounter,
};

describe('BRONZE_BRIDGES registry (wired-to-nothing guard)', () => {
  it('contains exactly the known server-trusted Bronze landings', () => {
    const eventNames = BRONZE_BRIDGES.map((b) => b.eventName).sort();
    expect(eventNames).toEqual(
      [
        'gokwik.awb_status.v1',
        'gokwik.rto_predict.v1',
        'order.live.v1',
        'shiprocket.shipment_status.v1',
        'shopflo.checkout_abandoned.v1',
      ].sort(),
    );
  });

  it('every entry has non-empty config fields', () => {
    for (const b of BRONZE_BRIDGES) {
      expect(b.groupIdEnv, 'groupIdEnv').toBeTruthy();
      expect(b.defaultGroupId, 'defaultGroupId').toBeTruthy();
      expect(b.eventName, 'eventName').toBeTruthy();
      expect(b.metricName, 'metricName').toBeTruthy();
    }
  });

  it('event names, group ids, env vars and metrics are all unique (no collisions)', () => {
    for (const key of ['eventName', 'defaultGroupId', 'groupIdEnv', 'metricName'] as const) {
      const vals = BRONZE_BRIDGES.map((b) => b[key]);
      expect(new Set(vals).size, `${key} must be unique`).toBe(vals.length);
    }
  });

  it('buildBronzeBridges returns exactly one consumer per registry entry (1:1 coverage)', () => {
    const consumers = buildBronzeBridges(deps);
    expect(consumers).toHaveLength(BRONZE_BRIDGES.length);
    for (const c of consumers) expect(typeof c.start).toBe('function');
  });
});
