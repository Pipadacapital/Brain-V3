/**
 * BackfillOrderConsumer — KafkaJS consumer for {env}.collector.order.backfill.v1.
 *
 * Lane isolation (ADR-BF-7 / D-3 / SI-3):
 *   - Topic: {env}.collector.order.backfill.v1  (NOT the live {env}.collector.event.v1)
 *   - Consumer group: stream-worker-backfill     (NOT stream-worker-live)
 *   - Single partition on the backfill topic = natural throughput cap
 *   - Structurally impossible to lag the live consumer group (different topics)
 *
 * Pipeline per message (ADR-BF-8):
 *   1. ProcessEventUseCase → Bronze write (idempotent on event_id — I-ST04)
 *
 * MEDALLION REALIGNMENT (Epic 1 / decision B): the PG-ledger write (ADR-BF-9
 * writeProvisionalRecognition) has been REMOVED. The revenue recognition ledger is now
 * built FROM Bronze by dbt (silver_order_recognition → brain_gold.gold_revenue_ledger,
 * `make recognition-refresh`), so a backfilled order reaches the ledger by landing in Bronze
 * here — the duplicate PG write is gone. This consumer is now a pure Bronze-backfill writer.
 *
 * Offset-commit ordering (D-7 — same discipline as CollectorEventConsumer):
 *   Kafka offset committed ONLY after the Bronze write succeeds.
 *   On throw: increment retry counter, do NOT commit offset.
 *   After MAX_RETRY=5 for the same offset: route to DLQ, then commit offset.
 */

import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { extractKafkaTraceContext } from '@brain/observability';
import { context } from '@opentelemetry/api';
import { ProcessEventUseCase, ProcessResult } from '../../application/ProcessEventUseCase.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { log } from "../../log.js";

const MAX_RETRY = 5;

export class BackfillOrderConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  /** Durable retry-counter scope (T2-8): `{groupId}:{topic}` — isolates same-topic groups. */
  private readonly retryScope: string;

  constructor(
    private readonly kafka: Kafka,
    private readonly processEvent: ProcessEventUseCase,
    private readonly topic: string,
    private readonly groupId: string,
    /** Durable (Redis) retry counter — survives restarts so a poison message reaches the DLQ (T2-8). */
    private readonly retryCounter: IRetryCounter,
  ) {
    this.consumer = kafka.consumer({ groupId });
    this.dlqProducer = new DlqProducer(kafka);
    this.retryScope = `${groupId}:${topic}`;
  }

  async start(): Promise<void> {
    await this.dlqProducer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });

    await this.consumer.run({
      // autoCommit=false: commit manually ONLY after both Bronze + ledger writes confirmed (D-7).
      autoCommit: false,

      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;
        const offset = message.offset;
        const now = new Date().toISOString();

        // Resume producer trace context across the Kafka boundary (observability skill).
        const traceCtx = extractKafkaTraceContext(
          (message.headers ?? {}) as Record<string, Buffer | string | undefined>,
        );

        return context.with(traceCtx, async () => {
        try {
          // ── Step 1: Bronze write via ProcessEventUseCase (ADR-BF-8) ───────────
          // Idempotent on event_id (Redis NX + PG PK ON CONFLICT DO NOTHING)
          const result: ProcessResult = await this.processEvent.execute(message.value, now);

          if (result.outcome === 'invalid') {
            // Invalid messages go directly to DLQ (no point retrying a parse error)
            await this.dlqProducer.send(
              `${topic}.dlq`,
              message.key?.toString() ?? null,
              message.value,
              result.reason ?? 'backfill_validation_error',
            );
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            await this.retryCounter.reset(this.retryScope, partition, offset);
            log.info(`DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`);
            return;
          }

          // written | dedup_hit | pk_conflict → commit offset (D-7).
          await this.consumer.commitOffsets([
            { topic, partition, offset: String(Number(offset) + 1) },
          ]);
          await this.retryCounter.reset(this.retryScope, partition, offset);
          log.info(`[backfill-consumer] ${result.outcome} brand=${result.brandId} ` +
                        `event=${result.eventId} partition=${partition} offset=${offset}`);
        } catch (err) {
          // Write error — do NOT commit offset (D-7). Increment retry counter.
          const current = await this.retryCounter.increment(this.retryScope, partition, offset);

          log.error(`[backfill-consumer] write error (attempt ${current}/${MAX_RETRY}) ` +
                        `partition=${partition} offset=${offset}`, { err: err });

          if (current >= MAX_RETRY) {
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
              await this.retryCounter.reset(this.retryScope, partition, offset);
              log.warn(`DLQ (max retry) partition=${partition} offset=${offset}`);
            } catch (dlqErr) {
              log.error('DLQ produce failed — not committing offset', { err: dlqErr });
            }
          }

          if (current < MAX_RETRY) {
            throw err;
          }
        }

        }); // end context.with(traceCtx, ...)
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.stop();
    await this.consumer.disconnect();
    await this.dlqProducer.disconnect();
  }
}
