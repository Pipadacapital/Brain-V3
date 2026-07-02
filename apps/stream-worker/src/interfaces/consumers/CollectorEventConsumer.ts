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
 *   AUD-PERF-009: commits are BATCHED (OffsetCommitBatcher, every N msgs / T ms) — the offset is
 *   recorded as committable only AFTER the write confirms, so D-7 holds at batch granularity. A
 *   crash inside a window redelivers already-written messages; Bronze dedup (Redis NX + PK
 *   backstop) absorbs the replay. DLQ/quarantine paths flush immediately (rare, keeps promptness).
 *
 * Retry policy (D-7 / T2-8):
 *   Per (groupId, topic, partition, offset) DURABLE (Redis) retry counter — survives restarts.
 *   On ProcessEventUseCase throw: increment retry counter, do NOT commit offset.
 *   After MAX_RETRY=5 for the same offset: route to DLQ, then commit offset.
 *
 * Branch: feat/data-plane-ingest-spine — Track A (data-engineer) Slice 3.
 */
import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { incrementCounter, extractKafkaTraceContext } from '@brain/observability';
import { context } from '@opentelemetry/api';
import { ProcessEventUseCase, ProcessResult } from '../../application/ProcessEventUseCase.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { OffsetCommitBatcher } from './OffsetCommitBatcher.js';
import { log } from "../../log.js";

/** Maximum per-(partition, offset) retry count before DLQ routing. */
const MAX_RETRY = 5;

export class CollectorEventConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  /** Durable retry-counter scope (T2-8): `{groupId}:{topic}` — isolates same-topic groups. */
  private readonly retryScope: string;
  /** Batched offset commits (AUD-PERF-009) — D-7 preserved at batch granularity. */
  private readonly commitBatcher: OffsetCommitBatcher;
  /**
   * Offsets that FAILED at least once (`{partition}:{offset}`), populated only in the catch
   * path (AUD-PERF-009). The durable Redis retry counter only exists after a failure, so
   * retryCounter.reset (an unconditional Redis DEL) is skipped for the never-failed 99%+.
   */
  private readonly failedOffsets = new Set<string>();

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
    this.commitBatcher = new OffsetCommitBatcher(topic, (entries) =>
      this.consumer.commitOffsets(entries),
    );
  }

  /** Reset the durable retry counter ONLY when this offset actually failed before (T2-8 kept). */
  private async resetIfFailed(partition: number, offset: string): Promise<void> {
    if (this.failedOffsets.delete(`${partition}:${offset}`)) {
      await this.retryCounter.reset(this.retryScope, partition, offset);
    }
  }

  async start(): Promise<void> {
    await this.dlqProducer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });
    this.commitBatcher.start();

    await this.consumer.run({
      // autoCommit=false: we commit manually ONLY after confirmed write (D-7).
      autoCommit: false,

      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;
        const offset = message.offset;
        const now = new Date().toISOString();

        // Resume the producer's trace context across the Kafka boundary (observability skill).
        // propagation.extract() reads W3C 'traceparent'/'tracestate' from message headers so
        // spans started here are children of the producer's span, not orphaned root spans.
        const traceCtx = extractKafkaTraceContext(
          (message.headers ?? {}) as Record<string, Buffer | string | undefined>,
        );
        // OBS-3: bind the producer's custom correlation_id header onto a per-message child logger
        // so log lines correlate to the originating request even where no span is started.
        const correlationId = message.headers?.['correlation_id']?.toString();
        const msgLog = correlationId ? log.child({ correlation_id: correlationId }) : log;
        await context.with(traceCtx, async () => {

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
            // Commit AFTER DLQ produce confirmed (D-7) — immediate flush (rare path).
            await this.commitBatcher.record(partition, offset);
            await this.commitBatcher.flush();
            await this.resetIfFailed(partition, offset);
            msgLog.info(`DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`);
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
            await this.commitBatcher.record(partition, offset);
            await this.commitBatcher.flush();
            await this.resetIfFailed(partition, offset);
            msgLog.info(`QUARANTINE partition=${partition} offset=${offset} reason=${result.reason} brand=${result.brandId ?? 'unresolved'}`);
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

          // Durable-write throughput — the numerator of ingest freshness (C2 / R-05).
          // A stalled spine = collector topic advancing while this stays flat (BrainIngestStale).
          if (result.outcome === 'written') {
            incrementCounter('bronze_write_total', { brand_id: result.brandId ?? 'unknown' });
          }

          // written | dedup_hit | pk_conflict → record committable AFTER confirmed write (D-7,
          // batched per AUD-PERF-009). Success log at debug — per-event info drowned the lane.
          await this.commitBatcher.record(partition, offset);
          await this.resetIfFailed(partition, offset);
          msgLog.debug(`${result.outcome} brand=${result.brandId} event=${result.eventId} partition=${partition} offset=${offset}`);
        } catch (err) {
          // Write error — do NOT commit offset (D-7). Increment retry counter.
          const current = await this.retryCounter.increment(this.retryScope, partition, offset);
          this.failedOffsets.add(`${partition}:${offset}`);

          msgLog.error(`write error (attempt ${current}/${MAX_RETRY}) partition=${partition} offset=${offset}`, { err: err });

          if (current >= MAX_RETRY) {
            // After MAX_RETRY failures → DLQ → commit (D-7).
            try {
              await this.dlqProducer.send(
                `${topic}.dlq`,
                message.key?.toString() ?? null,
                message.value,
                `max_retry_exceeded: ${String(err)}`,
              );
              await this.commitBatcher.record(partition, offset);
              await this.commitBatcher.flush();
              await this.resetIfFailed(partition, offset);
              msgLog.warn(`DLQ (max retry) partition=${partition} offset=${offset}`);
            } catch (dlqErr) {
              msgLog.error('DLQ produce failed — not committing offset', { err: dlqErr });
              // Do NOT commit — will retry the whole message next poll.
            }
          }
          // If retry < MAX_RETRY: throw propagates to KafkaJS, which re-delivers
          // the message on next poll without committing the offset.
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
    // Final flush AFTER the run loop stops (in-flight eachMessage drained) and BEFORE
    // disconnect (group membership still valid for the commit request).
    await this.commitBatcher.stop();
    await this.consumer.disconnect();
    await this.dlqProducer.disconnect();
  }
}
