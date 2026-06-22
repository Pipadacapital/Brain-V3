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
 *
 * Durable retry counter (T2-8): the 5th constructor arg wires the same Redis-backed
 * RetryCounterAdapter that ConsentSuppressor/Backfill consumers receive. Without it,
 * the in-memory Map resets on pod restart so a poison message would never reach the DLQ
 * and would wedge the partition forever. The retryScope isolates this group from other
 * consumer groups reading the same topic.
 */

import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { ResolveIdentityUseCase } from '../application/ResolveIdentityUseCase.js';
import { DlqProducer } from '../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../infrastructure/redis/RetryCounterAdapter.js';
import { log } from "../log.js";

const MAX_RETRY = 5;

export class IdentityBridgeConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  /** Durable retry-counter scope (T2-8): `{groupId}:{topic}` — isolates same-topic groups. */
  private readonly retryScope: string;

  constructor(
    private readonly kafka: Kafka,
    private readonly resolveIdentity: ResolveIdentityUseCase,
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
            await this.retryCounter.reset(this.retryScope, partition, offset);
            log.info(`DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`);
            return;
          }

          // All other outcomes (minted/linked/merged/suppressed/skipped/no_identifiers)
          // → commit offset after confirmed write
          await this.consumer.commitOffsets([
            { topic, partition, offset: String(Number(offset) + 1) },
          ]);
          await this.retryCounter.reset(this.retryScope, partition, offset);
          log.info(`[identity-bridge] ${result.outcome} brand=${result.brandId ?? 'unknown'} ` +
                        `event=${result.eventId ?? 'unknown'} brain_id=${result.brainId ?? 'none'} ` +
                        `partition=${partition} offset=${offset}`);
        } catch (err) {
          // Write error — do NOT commit offset. Increment durable retry counter (T2-8).
          const current = await this.retryCounter.increment(this.retryScope, partition, offset);

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
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.stop();
    await this.consumer.disconnect();
    await this.dlqProducer.disconnect();
  }
}
