/**
 * EventBronzeBridgeConsumer — lands a specific server-trusted event_name in Bronze (P0 pattern).
 *
 * Several connectors (Shopflo checkout-abandoned, GoKwik RTO-Predict) resolve brand_id server-side
 * (MT-1, from the connector DB row) and produce a well-formed CollectorEventV1 to the live topic —
 * but those events carry NO install_token, so the pixel-lane CollectorEventConsumer
 * (enforceTenantDerivation=true) QUARANTINES them out of Bronze. Their read seams then render
 * permanent no_data. This bridge is the generic fix: a separate consumer group that filters ONE
 * event_name and lands it in Bronze with enforceTenantDerivation=FALSE (the brand_id is already
 * server-trusted, like the backfill lane).
 *
 * One instance per (event_name, consumer group). Manual at-least-once commit ONLY after the Bronze
 * write / dedup-hit confirms (D-7); durable Redis retry counter (T2-8) → DLQ after MAX_RETRY.
 *
 * WIRED in main.ts — do NOT remove without updating the corresponding *-bronze-wiring.e2e.test.ts.
 */
import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { incrementCounter, extractKafkaTraceContext } from '@brain/observability';
import { context } from '@opentelemetry/api';
import { ProcessEventUseCase, ProcessResult } from '../../application/ProcessEventUseCase.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { log } from '../../log.js';

/** Maximum per-(partition, offset) retry count before DLQ routing. */
const MAX_RETRY = 5;

export class EventBronzeBridgeConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  /** Durable retry-counter scope (T2-8): `{groupId}:{topic}` — isolates same-topic groups. */
  private readonly retryScope: string;

  constructor(
    kafka: Kafka,
    /** A ProcessEventUseCase built with enforceTenantDerivation=FALSE (brand_id server-trusted). */
    private readonly processEvent: ProcessEventUseCase,
    private readonly topic: string,
    private readonly groupId: string,
    private readonly retryCounter: IRetryCounter,
    /** The ONLY event_name this bridge lands in Bronze (others are committed + skipped). */
    private readonly eventName: string,
    /** Observability counter incremented per Bronze write (e.g. 'shopflo_bronze_write_total'). */
    private readonly writeCounter: string,
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
      autoCommit: false,
      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;
        const offset = message.offset;
        const commitNext = () =>
          this.consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);

        // Resume producer trace context across the Kafka boundary (observability skill).
        const traceCtx = extractKafkaTraceContext(
          (message.headers ?? {}) as Record<string, Buffer | string | undefined>,
        );
        // OBS-3: bind the producer's custom correlation_id header onto a per-message child logger
        // so log lines correlate to the originating request even where no span is started.
        const correlationId = message.headers?.['correlation_id']?.toString();
        const msgLog = correlationId ? log.child({ correlation_id: correlationId }) : log;
        return context.with(traceCtx, async () => {

        // ── Filter: only our event_name (cheap header peek, fallback to body) ──
        let eventName: string | null = null;
        const headerName = message.headers?.['event_name'];
        if (headerName) eventName = headerName.toString('utf8');
        if (eventName === null && message.value) {
          try {
            const parsed = JSON.parse(message.value.toString('utf8')) as Record<string, unknown>;
            eventName = typeof parsed['event_name'] === 'string' ? parsed['event_name'] : null;
          } catch {
            await commitNext(); // unparseable — not ours (the pixel lane DLQs it)
            return;
          }
        }
        if (eventName !== this.eventName) {
          await commitNext();
          return;
        }

        const now = new Date().toISOString();
        try {
          const result: ProcessResult = await this.processEvent.execute(message.value, now);

          if (result.outcome === 'invalid') {
            await this.dlqProducer.send(
              `${topic}.dlq`,
              message.key?.toString() ?? null,
              message.value,
              result.reason ?? 'validation_error',
            );
            await commitNext();
            await this.retryCounter.reset(this.retryScope, partition, offset);
            msgLog.info(`[bronze-bridge:${this.eventName}] DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`);
            return;
          }

          // written | dedup_hit | pk_conflict → accounted for; commit (D-7).
          if (result.outcome === 'written') {
            incrementCounter(this.writeCounter, { brand_id: result.brandId ?? 'unknown' });
          }
          await commitNext();
          await this.retryCounter.reset(this.retryScope, partition, offset);
          msgLog.info(`[bronze-bridge:${this.eventName}] ${result.outcome} brand=${result.brandId} event=${result.eventId} partition=${partition} offset=${offset}`);
        } catch (err) {
          const current = await this.retryCounter.increment(this.retryScope, partition, offset);
          msgLog.error(`[bronze-bridge:${this.eventName}] write error (attempt ${current}/${MAX_RETRY}) partition=${partition} offset=${offset}`, { err });

          if (current >= MAX_RETRY) {
            try {
              await this.dlqProducer.send(
                `${topic}.dlq`,
                message.key?.toString() ?? null,
                message.value,
                `max_retry_exceeded: ${String(err)}`,
              );
              await commitNext();
              await this.retryCounter.reset(this.retryScope, partition, offset);
              msgLog.warn(`[bronze-bridge:${this.eventName}] DLQ (max retry) partition=${partition} offset=${offset}`);
            } catch (dlqErr) {
              msgLog.error(`[bronze-bridge:${this.eventName}] DLQ produce failed — not committing offset`, { err: dlqErr });
            }
          }
          if (current < MAX_RETRY) throw err; // KafkaJS redelivers without committing
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
