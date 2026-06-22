/**
 * ConsentSuppressorConsumer — KafkaJS consumer that projects consent_flags off the
 * EXISTING dev.collector.event.v1 topic into the consent SoR (consent_record +
 * consent_tombstone). A SEPARATE consumer group (stream-worker-consent-suppressor)
 * on the same topic — NO new topic, NO new deployable (I-E05). Mirrors
 * IdentityBridgeConsumer / CollectorEventConsumer.
 *
 * Offset-commit ordering (D-7 — CRITICAL):
 *   Commit ONLY after ProjectConsentUseCase returns without throwing (the DB write —
 *   or an idempotent dedup hit — is confirmed). On write error: do NOT commit;
 *   increment a per-(partition,offset) retry counter; DLQ after MAX_RETRY=5.
 *   Committing before the consent write = a withdrawal could be silently lost
 *   (the one invariant that must never fail-open).
 *
 * Salt failure (D-2) is a write error: ProjectConsentUseCase lets SaltProvider throw,
 *   the offset is NOT committed, and after MAX_RETRY the message goes to DLQ — never
 *   projected with an empty/default salt.
 *
 * Replayable: re-consuming the topic from the beginning re-projects the same rows
 *   (ON CONFLICT DO NOTHING) → identical suppression state. The batch rebuild IS this
 *   same code path.
 */
import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { extractKafkaTraceContext } from '@brain/observability';
import { context } from '@opentelemetry/api';
import { ProjectConsentUseCase } from '../../application/ProjectConsentUseCase.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { log } from '../../log.js';

const MAX_RETRY = 5;

export class ConsentSuppressorConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  /** Durable retry-counter scope (T2-8): `{groupId}:{topic}` — isolates same-topic groups. */
  private readonly retryScope: string;

  constructor(
    private readonly kafka: Kafka,
    private readonly projectConsent: ProjectConsentUseCase,
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

        return context.with(traceCtx, async () => {
        try {
          const result = await this.projectConsent.execute(message.value, now);

          if (result.outcome === 'invalid') {
            // Unparseable / missing brand_id|event_id → DLQ (no retry helps).
            await this.dlqProducer.send(
              `${topic}.dlq`,
              message.key?.toString() ?? null,
              message.value,
              result.reason ?? 'consent_validation_error',
            );
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            await this.retryCounter.reset(this.retryScope, partition, offset);
            log.info(`DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`);
            return;
          }

          // projected | no_consent_flags | no_subject → committed after confirmed
          // write (or correct skip). no_consent_flags/no_subject are NORMAL: most
          // events carry no consent envelope or no addressable subject — nothing to
          // project, and the read-side default (no granted row) remains fail-closed.
          await this.consumer.commitOffsets([
            { topic, partition, offset: String(Number(offset) + 1) },
          ]);
          await this.retryCounter.reset(this.retryScope, partition, offset);
          log.info(`[consent-suppressor] ${result.outcome} brand=${result.brandId ?? 'unknown'} ` +
                          `event=${result.eventId ?? 'unknown'} subject=${result.subjectHash ? result.subjectHash.slice(0, 12) + '…' : 'none'} ` +
                          `records=${result.recordCount ?? 0} tombstones=${result.tombstoneCount ?? 0} ` +
                          `partition=${partition} offset=${offset}`);
        } catch (err) {
          // Write error (incl. salt failure D-2) — do NOT commit. Retry → DLQ@MAX_RETRY.
          const current = await this.retryCounter.increment(this.retryScope, partition, offset);

          log.error(`[consent-suppressor] write error (attempt ${current}/${MAX_RETRY}) ` +
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
