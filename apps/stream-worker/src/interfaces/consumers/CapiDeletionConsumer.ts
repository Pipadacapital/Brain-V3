/**
 * CapiDeletionConsumer — KafkaJS consumer that fires the RETROACTIVE Meta CAPI
 * deletion on a consent withdrawal/erasure of the 'advertising' category. Reads the
 * SAME live dev.collector.event.v1 topic as the consent suppressor in a SEPARATE
 * consumer group (stream-worker-capi-deletion) — NO new topic, NO new deployable
 * (I-E05). Mirrors ConsentSuppressorConsumer EXACTLY.
 *
 * THE ≤15min ACCEPTANCE GATE (COMPLIANCE.md — withdrawal retroactive deletion):
 *   this consumer runs on the live lane (same lag profile as the consent suppressor
 *   whose <15min SLA is already proven). On an 'advertising' withdrawal it records a
 *   capi_deletion_log row whose requested_at − tombstoned_at is the measured deletion
 *   latency. Committing the offset only AFTER the deletion request is durably written
 *   guarantees a withdrawal is never silently lost.
 *
 * Offset-commit ordering (D-7 — CRITICAL):
 *   Commit ONLY after RequestCapiDeletionUseCase returns without throwing (the DB write
 *   — or an idempotent dedup hit — is confirmed). On write error: do NOT commit;
 *   increment a per-(partition,offset) retry counter; DLQ after MAX_RETRY=5.
 *   Committing before the deletion write = a withdrawal could be silently lost (the one
 *   invariant that must never fail-open for a deletion path).
 *
 * Salt failure (D-2) is a write error: the use-case lets SaltProvider throw, the offset
 *   is NOT committed, and after MAX_RETRY the message goes to DLQ — never recorded with
 *   a bad/empty salt (which would target the wrong subject's passbacks).
 *
 * Replayable: re-consuming the topic re-records the same deletion (ON CONFLICT DO
 *   NOTHING) → identical state. 3× replay → one deletion request.
 */
import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { RequestCapiDeletionUseCase } from '../../application/RequestCapiDeletionUseCase.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';

const MAX_RETRY = 5;
type RetryKey = string;

export class CapiDeletionConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  private readonly retryCount = new Map<RetryKey, number>();

  constructor(
    private readonly kafka: Kafka,
    private readonly requestDeletion: RequestCapiDeletionUseCase,
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
          const result = await this.requestDeletion.execute(message.value, now);

          if (result.outcome === 'invalid') {
            // Unparseable / missing brand_id|event_id → DLQ (no retry helps).
            await this.dlqProducer.send(
              `${topic}.dlq`,
              message.key?.toString() ?? null,
              message.value,
              result.reason ?? 'capi_deletion_validation_error',
            );
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            this.retryCount.delete(retryKey);
            console.info(
              `[capi-deletion] DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`,
            );
            return;
          }

          // deletion_requested | not_a_withdrawal | no_consent_flags | no_subject →
          // committed after a confirmed write (or a correct skip). Most events are NOT
          // advertising withdrawals (not_a_withdrawal) — nothing to delete, fail-closed.
          await this.consumer.commitOffsets([
            { topic, partition, offset: String(Number(offset) + 1) },
          ]);
          this.retryCount.delete(retryKey);
          console.info(
            `[capi-deletion] ${result.outcome} brand=${result.brandId ?? 'unknown'} ` +
              `event=${result.eventId ?? 'unknown'} subject=${result.subjectHash ? result.subjectHash.slice(0, 12) + '…' : 'none'} ` +
              `status=${result.status ?? '-'} scope=${result.eventCount ?? 0} ` +
              `partition=${partition} offset=${offset}`,
          );
        } catch (err) {
          // Write error (incl. salt failure D-2) — do NOT commit. Retry → DLQ@MAX_RETRY.
          const current = (this.retryCount.get(retryKey) ?? 0) + 1;
          this.retryCount.set(retryKey, current);

          console.error(
            `[capi-deletion] write error (attempt ${current}/${MAX_RETRY}) ` +
              `partition=${partition} offset=${offset}`,
            err,
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
              this.retryCount.delete(retryKey);
              console.warn(
                `[capi-deletion] DLQ (max retry) partition=${partition} offset=${offset}`,
              );
            } catch (dlqErr) {
              console.error('[capi-deletion] DLQ produce failed — not committing offset', dlqErr);
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
