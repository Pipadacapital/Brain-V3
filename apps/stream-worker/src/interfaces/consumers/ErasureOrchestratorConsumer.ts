/**
 * ErasureOrchestratorConsumer — KafkaJS consumer group for DPDP/PDPL crypto-shred erasure.
 *
 * Reads the SAME live collector topic as ConsentSuppressorConsumer / CapiDeletionConsumer
 * in a SEPARATE consumer group (stream-worker-erasure-orchestrator) — NO new topic, NO new
 * deployable (I-E05). On a subject-erasure event it drives the ordered 6-step sequence via
 * EraseSubjectUseCase. Most events are NOT erasures ('no_consent_flags' / 'not_an_erasure')
 * and are committed immediately as skips (normal — high-throughput filter pattern).
 *
 * Mirrors CapiDeletionConsumer EXACTLY in offset/DLQ/retry discipline:
 *
 * OFFSET-COMMIT ORDERING (D-7 — CRITICAL):
 *   Commit ONLY after EraseSubjectUseCase.execute() returns without throwing (the DB
 *   writes — shred + erasure log + surrogate — are confirmed). On write error: do NOT
 *   commit; increment the per-(partition,offset) durable retry counter; DLQ@MAX_RETRY=5.
 *   Committing before the shred write = an erasure could be silently lost (the one
 *   invariant that must never fail-open for a GDPR/DPDP deletion path).
 *
 * SALT FAILURE (D-2) is a write error: EraseSubjectUseCase lets SaltProvider throw, the
 *   offset is NOT committed, and after MAX_RETRY the message goes to DLQ — never processed
 *   with a bad/empty salt (which would hash the wrong subject and shred the wrong DEK).
 *
 * STEP 4 (Bronze raw erasure — AUD-OPS-037): with the Argo submitter WIRED, a submit failure
 *   propagates like any write error (no commit → retry → DLQ@MAX_RETRY — an unsubmitted Bronze
 *   sweep is never silently dropped). With NO submitter (dev), shredIcebergSnapshots throws
 *   NotImplementedYet, which the use case catches internally and continues — the consumer
 *   NEVER sees that as a write error.
 *
 * REPLAYABLE: re-consuming the topic re-runs the ordered sequence (all steps idempotent) →
 *   same outcome. 3× replay → one erasure record, one DEK shred, one CAPI deletion.
 *
 * INVALID → DLQ immediately (no retry helps for unparseable / missing brand_id|event_id).
 * Skips ('not_an_erasure', 'no_consent_flags', 'no_subject', 'no_brain_id') → commit.
 */
import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { extractKafkaTraceContext } from '@brain/observability';
import { context } from '@opentelemetry/api';
import type { EraseSubjectUseCase } from '../../application/EraseSubjectUseCase.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { log } from '../../log.js';

const MAX_RETRY = 5;

export class ErasureOrchestratorConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  /** Durable retry-counter scope (T2-8): `{groupId}:{topic}` — isolates same-topic groups. */
  private readonly retryScope: string;

  constructor(
    private readonly kafka: Kafka,
    private readonly eraseSubject: EraseSubjectUseCase,
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
      autoCommit: false,

      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;
        const offset = message.offset;
        const now = new Date().toISOString();

        // Resume producer trace context across the Kafka boundary (observability skill).
        const traceCtx = extractKafkaTraceContext(
          (message.headers ?? {}) as Record<string, Buffer | string | undefined>,
        );
        const correlationId = message.headers?.['correlation_id']?.toString();
        const msgLog = correlationId ? log.child({ correlation_id: correlationId }) : log;

        return context.with(traceCtx, async () => {
          try {
            const result = await this.eraseSubject.execute(message.value, now);

            if (result.outcome === 'invalid') {
              // Unparseable / missing brand_id|event_id → DLQ immediately (no retry helps).
              await this.dlqProducer.send(
                `${topic}.dlq`,
                message.key?.toString() ?? null,
                message.value,
                result.reason ?? 'erasure_validation_error',
              );
              await this.consumer.commitOffsets([
                { topic, partition, offset: String(Number(offset) + 1) },
              ]);
              await this.retryCounter.reset(this.retryScope, partition, offset);
              msgLog.info(
                `[erasure-orchestrator] DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`,
              );
              return;
            }

            // erased | not_an_erasure | no_consent_flags | no_subject | no_brain_id →
            // committed after confirmed write (or correct skip). The skip outcomes are
            // NORMAL: the vast majority of events are not erasures.
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            await this.retryCounter.reset(this.retryScope, partition, offset);

            if (result.outcome === 'erased') {
              msgLog.info(
                `[erasure-orchestrator] erased brand=${result.brandId} ` +
                `event=${result.eventId} brain_id=${result.brainId} ` +
                `surrogate=${result.surrogateId} ` +
                `bronze_raw_workflow=${result.bronzeRawWorkflow ?? 'not_configured'} ` +
                `partition=${partition} offset=${offset}`,
              );
            } else if (result.outcome === 'no_brain_id') {
              // Log at WARN: a valid erasure signal but subject not found in identity graph.
              msgLog.warn(
                `[erasure-orchestrator] no_brain_id — subject hash not in identity graph ` +
                `brand=${result.brandId ?? 'unknown'} event=${result.eventId ?? 'unknown'} ` +
                `partition=${partition} offset=${offset}`,
              );
            } else {
              msgLog.info(
                `[erasure-orchestrator] ${result.outcome} brand=${result.brandId ?? 'unknown'} ` +
                `event=${result.eventId ?? 'unknown'} partition=${partition} offset=${offset}`,
              );
            }
          } catch (err) {
            // Write error (shred / DB / salt / Neo4j) — do NOT commit. Retry → DLQ@MAX_RETRY.
            const current = await this.retryCounter.increment(this.retryScope, partition, offset);

            msgLog.error(
              `[erasure-orchestrator] write error (attempt ${current}/${MAX_RETRY}) ` +
              `partition=${partition} offset=${offset}`,
              { err },
            );

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
                msgLog.warn(
                  `[erasure-orchestrator] DLQ (max retry) partition=${partition} offset=${offset}`,
                );
              } catch (dlqErr) {
                msgLog.error('[erasure-orchestrator] DLQ produce failed — not committing offset', {
                  err: dlqErr,
                });
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
