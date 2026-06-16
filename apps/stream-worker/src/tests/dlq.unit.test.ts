/**
 * dlq.unit.test.ts — Unit test for the DLQ routing path (F-QA-03).
 *
 * Verifies that when ProcessEventUseCase throws MAX_RETRY=5 consecutive
 * times for the same (partition, offset), CollectorEventConsumer:
 *   1. Does NOT commit the Kafka offset on retries 1-4.
 *   2. Routes the message to the DLQ topic on attempt 5.
 *   3. Commits the Kafka offset AFTER DLQ produce succeeds.
 *
 * All Kafka + Redis + Postgres seams are mocked — this is a pure unit test.
 * No live infra required.
 */

import { describe, it, expect, vi } from 'vitest';
import { CollectorEventConsumer } from '../interfaces/consumers/CollectorEventConsumer.js';

// ── Minimal Kafka mock ────────────────────────────────────────────────────────

/**
 * Build a minimal KafkaJS-compatible mock that records commitOffsets calls
 * and calls eachMessage with a single synthetic message.
 */
function buildKafkaMock(
  eachMessageFn: (payload: {
    topic: string;
    partition: number;
    message: { offset: string; key: Buffer | null; value: Buffer | null };
  }) => Promise<void>,
  commitOffsetsFn: (offsets: { topic: string; partition: number; offset: string }[]) => Promise<void>,
  dlqSendFn: (
    topic: string,
    key: string | null,
    value: Buffer | null,
    reason: string,
  ) => Promise<void>,
) {
  // Internal state: retry counter tracks re-throws vs. recoveries
  let eachMessageHandler:
    | ((payload: {
        topic: string;
        partition: number;
        message: { offset: string; key: Buffer | null; value: Buffer | null };
      }) => Promise<void>)
    | null = null;

  const consumer = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    commitOffsets: commitOffsetsFn,
    run: vi.fn().mockImplementation(async (opts: { eachMessage: typeof eachMessageFn }) => {
      eachMessageHandler = opts.eachMessage;
    }),
  };

  const producer = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockImplementation(async (payload: { topic: string; messages: { key?: string | Buffer | undefined; value: Buffer | null; headers?: Record<string, Buffer> }[] }) => {
      const msg = payload.messages[0];
      if (!msg) return;
      const key = msg.key instanceof Buffer ? msg.key.toString() : (typeof msg.key === 'string' ? msg.key : null);
      const reasonBuf = msg.headers?.['x-dlq-reason'];
      const reason = reasonBuf instanceof Buffer ? reasonBuf.toString() : 'unknown';
      await dlqSendFn(payload.topic, key, msg.value ?? null, reason);
    }),
  };

  const kafka = {
    consumer: vi.fn().mockReturnValue(consumer),
    producer: vi.fn().mockReturnValue(producer),
  };

  return {
    kafka: kafka as unknown as import('kafkajs').Kafka,
    // Expose a helper to drive eachMessage delivery
    async deliverMessage(payload: {
      topic: string;
      partition: number;
      message: { offset: string; key: Buffer | null; value: Buffer | null };
    }): Promise<void> {
      if (!eachMessageHandler) throw new Error('run() not called yet');
      await eachMessageHandler(payload);
    },
  };
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe('CollectorEventConsumer — DLQ routing (F-QA-03)', () => {
  it(
    'routes message to DLQ after MAX_RETRY=5 BronzeRepository errors and commits offset',
    async () => {
      // Mocked commitOffsets and DLQ send tracking
      const committedOffsets: { topic: string; partition: number; offset: string }[][] = [];
      const dlqMessages: { topic: string; key: string | null; value: Buffer | null; reason: string }[] = [];

      const commitOffsetsFn = vi.fn().mockImplementation(
        async (offsets: { topic: string; partition: number; offset: string }[]) => {
          committedOffsets.push(offsets);
        },
      );

      const dlqSendFn = vi.fn().mockImplementation(
        async (topic: string, key: string | null, value: Buffer | null, reason: string) => {
          dlqMessages.push({ topic, key, value, reason });
        },
      );

      // ProcessEventUseCase mock: throws on every execute() call to simulate persistent write errors
      let executeCallCount = 0;
      const mockUseCase = {
        execute: vi.fn().mockImplementation(async () => {
          executeCallCount++;
          throw new Error(`Simulated BronzeRepository failure (attempt ${executeCallCount})`);
        }),
      };

      const TOPIC = 'dev.collector.event.v1';
      const GROUP = 'dlq-unit-test';

      const { kafka, deliverMessage } = buildKafkaMock(
        async () => { /* placeholder — replaced by run() mock */ },
        commitOffsetsFn,
        dlqSendFn,
      );

      const consumer = new CollectorEventConsumer(
        kafka,
        mockUseCase as unknown as import('../application/ProcessEventUseCase.js').ProcessEventUseCase,
        TOPIC,
        GROUP,
      );

      await consumer.start();

      // ── Deliver the same message 5 times to exhaust MAX_RETRY ────────────────
      // KafkaJS re-delivers on throw (no offset commit). We simulate this by
      // calling deliverMessage with the same (partition=0, offset='42') 5 times.
      const syntheticMessage = {
        topic: TOPIC,
        partition: 0,
        message: {
          offset: '42',
          key: Buffer.from('test-key'),
          value: Buffer.from(
            JSON.stringify({
              schema_version: '1',
              event_id: 'dddd0001-dddd-4ddd-8ddd-dddddddddddd',
              brand_id: 'aaaa0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              correlation_id: 'corr-dlq-test',
              event_name: 'page.viewed',
              occurred_at: '2026-06-16T12:00:00Z',
            }),
          ),
        },
      };

      // Deliveries 1-4: useCase throws, consumer should NOT commit offset
      for (let i = 1; i <= 4; i++) {
        // eachMessage should throw so KafkaJS would re-deliver (simulate by catching the error)
        await deliverMessage(syntheticMessage).catch(() => { /* expected on retries 1-4 */ });
      }

      // Verify: no offset committed yet (only DLQ commit happens after attempt 5)
      expect(committedOffsets).toHaveLength(0);
      expect(dlqMessages).toHaveLength(0);

      // Delivery 5: useCase throws again → MAX_RETRY=5 reached → DLQ → commit offset
      await deliverMessage(syntheticMessage);

      // ── Assertions ────────────────────────────────────────────────────────────

      // useCase was called 5 times total
      expect(executeCallCount).toBe(5);

      // Exactly one DLQ message was produced
      expect(dlqMessages).toHaveLength(1);
      const dlqMsg = dlqMessages[0]!;
      expect(dlqMsg.topic).toBe(`${TOPIC}.dlq`);
      expect(dlqMsg.reason).toContain('max_retry_exceeded');

      // Offset committed exactly once — AFTER DLQ produce (D-7)
      expect(committedOffsets).toHaveLength(1);
      const committed = committedOffsets[0]![0]!;
      expect(committed.topic).toBe(TOPIC);
      expect(committed.partition).toBe(0);
      // Offset committed is the NEXT offset (current + 1)
      expect(committed.offset).toBe('43');

      await consumer.stop();
    },
    10_000,
  );
});
