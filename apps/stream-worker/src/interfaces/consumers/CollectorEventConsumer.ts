/**
 * CollectorEventConsumer — KafkaJS live consumer for dev.collector.event.v1.
 *
 * Offset-commit ordering (D-7 — CRITICAL):
 *   Kafka offset is committed ONLY after one of:
 *     (a) Bronze write confirmed  (outcome='written')
 *     (b) Dedup hit confirmed     (outcome='dedup_hit' | 'pk_conflict')
 *     (c) DLQ produce confirmed   (after MAX_RETRY=5 failures, outcome='invalid' or
 *                                  persistent write errors)
 *   Committing before write = silent data loss. Never commit on write error.
 *
 * Retry policy (D-7):
 *   Per (partition, offset) in-memory retry counter.
 *   On ProcessEventUseCase throw: increment retry counter, do NOT commit offset.
 *   After MAX_RETRY=5 for the same offset: route to DLQ, then commit offset.
 *
 * Branch: feat/data-plane-ingest-spine — Track A (data-engineer) Slice 3.
 */
import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { incrementCounter } from '@brain/observability';
import { ProcessEventUseCase, ProcessResult } from '../../application/ProcessEventUseCase.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';

/** Maximum per-(partition, offset) retry count before DLQ routing. */
const MAX_RETRY = 5;

/** In-memory retry counter key: `${partition}:${offset}` */
type RetryKey = string;

export class CollectorEventConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  /** Per-(partition, offset) retry counter — bounded by MAX_RETRY. */
  private readonly retryCount = new Map<RetryKey, number>();

  constructor(
    private readonly kafka: Kafka,
    private readonly processEvent: ProcessEventUseCase,
    private readonly topic: string,
    private readonly groupId: string,
  ) {
    this.consumer = kafka.consumer({ groupId });
    this.dlqProducer = new DlqProducer(kafka);
  }

  async start(): Promise<void> {
    await this.dlqProducer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });

    await this.consumer.run({
      // autoCommit=false: we commit manually ONLY after confirmed write (D-7).
      autoCommit: false,

      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;
        const offset = message.offset;
        const retryKey: RetryKey = `${partition}:${offset}`;
        const now = new Date().toISOString();

        try {
          const result: ProcessResult = await this.processEvent.execute(
            message.value,
            now,
          );

          if (result.outcome === 'invalid') {
            // Invalid (unparseable / Zod-fail) messages go directly to DLQ (no retry).
            await this.dlqProducer.send(
              `${topic}.dlq`,
              message.key?.toString() ?? null,
              message.value,
              result.reason ?? 'validation_error',
            );
            // Commit offset AFTER DLQ produce confirmed (D-7).
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            this.retryCount.delete(retryKey);
            console.info(`[stream-worker] DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`);
            return;
          }

          if (result.outcome === 'quarantined') {
            // R3: PARSED-but-failed-a-gate (tenant_unresolved / brand_mismatch /
            // consent_absent). Route to the .quarantine sink — NOT dropped, NOT Bronze.
            // Reuses the shipped DlqProducer with a .quarantine topic suffix (no new
            // producer, no new topic family). Then commit offset (mirrors .dlq, D-7).
            await this.dlqProducer.send(
              `${topic}.quarantine`,
              message.key?.toString() ?? null,
              message.value,
              result.reason ?? 'quarantined',
            );
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            this.retryCount.delete(retryKey);
            console.info(
              `[stream-worker] QUARANTINE partition=${partition} offset=${offset} reason=${result.reason} brand=${result.brandId ?? 'unresolved'}`,
            );
            return;
          }

          // R4: make dedup suppression OBSERVABLE — a forged/colliding event_id is a
          // counter increment, not a silent console.info. layer=pg (PK ON CONFLICT) or
          // layer=redis (NX). Labels are bounded/low-cardinality + PII-safe.
          if (result.outcome === 'pk_conflict' || result.outcome === 'dedup_hit') {
            incrementCounter('collector_dedup_conflict_total', {
              brand_id: result.brandId ?? 'unknown',
              layer: result.outcome === 'pk_conflict' ? 'pg' : 'redis',
              event_name: result.eventName ?? 'unknown',
            });
          }

          // written | dedup_hit | pk_conflict → commit offset (D-7).
          await this.consumer.commitOffsets([
            { topic, partition, offset: String(Number(offset) + 1) },
          ]);
          this.retryCount.delete(retryKey);
          console.info(
            `[stream-worker] ${result.outcome} brand=${result.brandId} event=${result.eventId} partition=${partition} offset=${offset}`,
          );
        } catch (err) {
          // Write error — do NOT commit offset (D-7). Increment retry counter.
          const current = (this.retryCount.get(retryKey) ?? 0) + 1;
          this.retryCount.set(retryKey, current);

          console.error(
            `[stream-worker] write error (attempt ${current}/${MAX_RETRY}) partition=${partition} offset=${offset}`,
            err,
          );

          if (current >= MAX_RETRY) {
            // After MAX_RETRY failures → DLQ → commit (D-7).
            try {
              await this.dlqProducer.send(
                `${topic}.dlq`,
                message.key?.toString() ?? null,
                message.value,
                `max_retry_exceeded: ${String(err)}`,
              );
              await this.consumer.commitOffsets([
                { topic, partition, offset: String(Number(offset) + 1) },
              ]);
              this.retryCount.delete(retryKey);
              console.warn(
                `[stream-worker] DLQ (max retry) partition=${partition} offset=${offset}`,
              );
            } catch (dlqErr) {
              console.error('[stream-worker] DLQ produce failed — not committing offset', dlqErr);
              // Do NOT commit — will retry the whole message next poll.
            }
          }
          // If retry < MAX_RETRY: throw propagates to KafkaJS, which re-delivers
          // the message on next poll without committing the offset.
          if (current < MAX_RETRY) {
            throw err;
          }
        }
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.stop();
    await this.consumer.disconnect();
    await this.dlqProducer.disconnect();
  }
}
