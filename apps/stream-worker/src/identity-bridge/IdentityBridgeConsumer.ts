/**
 * IdentityBridgeConsumer — KafkaJS consumer for identity resolution.
 *
 * Mirrors CollectorEventConsumer offset/DLQ discipline (architecture-plan §1):
 *   - autoCommit: false
 *   - offset committed ONLY after ResolveIdentityUseCase returns without throwing
 *   - per-(partition, offset) retry counter → DLQ@MAX_RETRY=5
 *
 * Replayable: consumes the SAME Bronze event topic (dev.collector.event.v1).
 * Rebuild: a --replay-from-bronze mode would read bronze_events in order — same
 * idempotent writer path, same hash, same brain_id (C-3 rebuild guarantee).
 *
 * Brand isolation: ResolveIdentityUseCase sets set_config GUC per brand in-txn.
 * Connects as brain_app (never superuser brain) — RLS enforced (F-4).
 */

import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { ResolveIdentityUseCase } from '../application/ResolveIdentityUseCase.js';
import { DlqProducer } from '../infrastructure/kafka/DlqProducer.js';
import { log } from "../log.js";

const MAX_RETRY = 5;
type RetryKey = string;

export class IdentityBridgeConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  private readonly retryCount = new Map<RetryKey, number>();

  constructor(
    private readonly kafka: Kafka,
    private readonly resolveIdentity: ResolveIdentityUseCase,
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
          const result = await this.resolveIdentity.execute(message.value, now);

          if (result.outcome === 'invalid') {
            // Parse errors go directly to DLQ (no point retrying)
            await this.dlqProducer.send(
              `${topic}.dlq`,
              message.key?.toString() ?? null,
              message.value,
              result.reason ?? 'identity_validation_error',
            );
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            this.retryCount.delete(retryKey);
            log.info(`DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`);
            return;
          }

          // All other outcomes (minted/linked/merged/suppressed/skipped/no_identifiers)
          // → commit offset after confirmed write
          await this.consumer.commitOffsets([
            { topic, partition, offset: String(Number(offset) + 1) },
          ]);
          this.retryCount.delete(retryKey);
          log.info(`[identity-bridge] ${result.outcome} brand=${result.brandId ?? 'unknown'} ` +
                        `event=${result.eventId ?? 'unknown'} brain_id=${result.brainId ?? 'none'} ` +
                        `partition=${partition} offset=${offset}`);
        } catch (err) {
          // Write error — do NOT commit offset. Increment retry counter.
          const current = (this.retryCount.get(retryKey) ?? 0) + 1;
          this.retryCount.set(retryKey, current);

          log.error(`[identity-bridge] write error (attempt ${current}/${MAX_RETRY}) ` +
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
