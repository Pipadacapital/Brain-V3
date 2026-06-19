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
import { ProjectConsentUseCase } from '../../application/ProjectConsentUseCase.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import { log } from "../../log.js";

const MAX_RETRY = 5;
type RetryKey = string;

export class ConsentSuppressorConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  private readonly retryCount = new Map<RetryKey, number>();

  constructor(
    private readonly kafka: Kafka,
    private readonly projectConsent: ProjectConsentUseCase,
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
      autoCommit: false,

      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;
        const offset = message.offset;
        const retryKey: RetryKey = `${partition}:${offset}`;
        const now = new Date().toISOString();

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
            this.retryCount.delete(retryKey);
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
          this.retryCount.delete(retryKey);
          log.info(`[consent-suppressor] ${result.outcome} brand=${result.brandId ?? 'unknown'} ` +
                          `event=${result.eventId ?? 'unknown'} subject=${result.subjectHash ? result.subjectHash.slice(0, 12) + '…' : 'none'} ` +
                          `records=${result.recordCount ?? 0} tombstones=${result.tombstoneCount ?? 0} ` +
                          `partition=${partition} offset=${offset}`);
        } catch (err) {
          // Write error (incl. salt failure D-2) — do NOT commit. Retry → DLQ@MAX_RETRY.
          const current = (this.retryCount.get(retryKey) ?? 0) + 1;
          this.retryCount.set(retryKey, current);

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
              this.retryCount.delete(retryKey);
              log.warn(`DLQ (max retry) partition=${partition} offset=${offset}`);
            } catch (dlqErr) {
              log.error('DLQ produce failed — not committing offset', { err: dlqErr });
            }
          }

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
