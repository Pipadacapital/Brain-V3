/**
 * live-attribution-clawback.test.ts — D1 live clawback fan-out safety.
 *
 * Pins the two properties that make wiring attribution into the LIVE ledger path safe:
 *   1. A confirmed reversal maps to a clawback with basis = −(order amount), reason rto_reversal,
 *      keyed on the order's event id.
 *   2. It is BEST-EFFORT: a throwing hook (e.g. StarRocks down) is swallowed and NEVER propagates
 *      — so it can't block the offset commit; the durable ledger row + the hourly reconcile job
 *      backstop any miss. (The full consumer→Kafka path is covered by live-ledger-wiring.e2e.)
 */
import { describe, it, expect } from 'vitest';
import type { Kafka } from 'kafkajs';
import {
  LiveLedgerBridgeConsumer,
  type LiveAttributionReversalHook,
} from '../interfaces/consumers/LiveLedgerBridgeConsumer.js';
import type { LedgerWriter } from '../infrastructure/pg/LedgerWriter.js';
import { InMemoryRetryCounter } from './support/InMemoryRetryCounter.js';

const BRAND = '11111111-1111-4111-8111-111111111111';
const EVENT = 'evt-live-1';

/** Minimal Kafka stand-in: the consumer ctor only needs consumer()/producer() to exist. */
function fakeKafka(): Kafka {
  return { consumer: () => ({}), producer: () => ({}) } as unknown as Kafka;
}

function liveOrderEvent(amountMinor: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      event_name: 'order.live.v1',
      brand_id: BRAND,
      event_id: EVENT,
      occurred_at: '2026-06-20T10:00:00.000Z',
      properties: {
        order_id: 'order-1',
        amount_minor: amountMinor,
        currency_code: 'INR',
        payment_method: 'prepaid',
      },
    }),
  );
}

type FireFn = (v: Buffer | null, b?: string, e?: string) => Promise<void>;

describe('LiveLedgerBridgeConsumer — best-effort live attribution clawback (D1)', () => {
  it('maps a reversal to a clawback with basis = −(order amount)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const hook: LiveAttributionReversalHook = {
      onRevenueReversal: async (r) => {
        calls.push(r as unknown as Record<string, unknown>);
      },
    };
    const c = new LiveLedgerBridgeConsumer(fakeKafka(), {} as LedgerWriter, 't', 'g', new InMemoryRetryCounter(), hook);
    await (c as unknown as { fireClawbackBestEffort: FireFn }).fireClawbackBestEffort(
      liveOrderEvent('150000'),
      BRAND,
      EVENT,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.['reversalBasisMinor']).toBe(-150000n);
    expect(calls[0]?.['reversalReason']).toBe('rto_reversal');
    expect(calls[0]?.['reversalLedgerEventId']).toBe(EVENT);
    expect(calls[0]?.['orderId']).toBe('order-1');
  });

  it('swallows a throwing hook — never propagates (cannot block offset commit)', async () => {
    const hook: LiveAttributionReversalHook = {
      onRevenueReversal: async () => {
        throw new Error('StarRocks down');
      },
    };
    const c = new LiveLedgerBridgeConsumer(fakeKafka(), {} as LedgerWriter, 't', 'g', new InMemoryRetryCounter(), hook);
    await expect(
      (c as unknown as { fireClawbackBestEffort: FireFn }).fireClawbackBestEffort(
        liveOrderEvent('100000'),
        BRAND,
        EVENT,
      ),
    ).resolves.toBeUndefined();
  });

  it('no-ops when no hook is injected (hourly reconcile job is the sole path)', async () => {
    const c = new LiveLedgerBridgeConsumer(fakeKafka(), {} as LedgerWriter, 't', 'g', new InMemoryRetryCounter());
    await expect(
      (c as unknown as { fireClawbackBestEffort: FireFn }).fireClawbackBestEffort(
        liveOrderEvent('100000'),
        BRAND,
        EVENT,
      ),
    ).resolves.toBeUndefined();
  });
});
