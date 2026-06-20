/**
 * ShopfloBronzeBridgeConsumer — lands `shopflo.checkout_abandoned.v1` events in Bronze (P0).
 *
 * The Shopflo webhook handler resolves brand_id server-side (MT-1, from the connector DB row),
 * builds a CollectorEventV1, and produces it to the live topic. But the live topic's primary
 * consumer (CollectorEventConsumer) runs with enforceTenantDerivation=true and QUARANTINES any
 * event without an install_token — so every Shopflo event was silently quarantined out of Bronze,
 * and computeCheckoutFunnel (reads bronze_events WHERE event_type='shopflo.checkout_abandoned.v1')
 * rendered permanent `no_data` while the connector showed Healthy. This bridge fixes that.
 *
 * Pattern (mirrors LiveLedgerBridgeConsumer + the backfill lane):
 *   - Same live topic, SEPARATE consumer group → independent offset, no impact on the pixel lane.
 *   - Filter: skip any event whose event_name != 'shopflo.checkout_abandoned.v1' (commit + continue).
 *   - Bronze write via a ProcessEventUseCase with enforceTenantDerivation=FALSE: the brand_id is
 *     ALREADY server-trusted (the webhook handler derived it from the connector row, not the body),
 *     exactly like the backfill-order lane. No install_token is required or expected.
 *   - Manual at-least-once commit ONLY after the Bronze write / dedup-hit confirms (D-7); durable
 *     Redis retry counter (T2-8) → DLQ after MAX_RETRY.
 *
 * WIRED in main.ts — do NOT remove without updating shopflo-bronze-wiring.e2e.test.ts.
 */
import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { incrementCounter } from '@brain/observability';
import { ProcessEventUseCase, ProcessResult } from '../../application/ProcessEventUseCase.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { log } from '../../log.js';

/** The sole event this bridge lands in Bronze (the checkout-funnel read seam consumes it). */
const SHOPFLO_EVENT_NAME = 'shopflo.checkout_abandoned.v1';

/** Maximum per-(partition, offset) retry count before DLQ routing. */
const MAX_RETRY = 5;

export class ShopfloBronzeBridgeConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  /** Durable retry-counter scope (T2-8): `{groupId}:{topic}` — isolates same-topic groups. */
  private readonly retryScope: string;

  constructor(
    private readonly kafka: Kafka,
    /** A ProcessEventUseCase built with enforceTenantDerivation=FALSE (brand_id server-trusted). */
    private readonly processEvent: ProcessEventUseCase,
    private readonly topic: string,
    private readonly groupId: string,
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
        const commitNext = () =>
          this.consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);

        // ── Filter: only shopflo.checkout_abandoned.v1 (cheap header peek, fallback to body) ──
        let eventName: string | null = null;
        const headerName = message.headers?.['event_name'];
        if (headerName) eventName = headerName.toString('utf8');
        if (eventName === null && message.value) {
          try {
            const parsed = JSON.parse(message.value.toString('utf8')) as Record<string, unknown>;
            eventName = typeof parsed['event_name'] === 'string' ? parsed['event_name'] : null;
          } catch {
            // Unparseable JSON — not our event; commit + continue (the pixel lane DLQs it).
            await commitNext();
            return;
          }
        }
        if (eventName !== SHOPFLO_EVENT_NAME) {
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
            log.info(`[shopflo-bronze] DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`);
            return;
          }

          // written | dedup_hit | pk_conflict | quarantined → the event is accounted for; commit (D-7).
          if (result.outcome === 'written') {
            incrementCounter('shopflo_bronze_write_total', { brand_id: result.brandId ?? 'unknown' });
          }
          await commitNext();
          await this.retryCounter.reset(this.retryScope, partition, offset);
          log.info(`[shopflo-bronze] ${result.outcome} brand=${result.brandId} event=${result.eventId} partition=${partition} offset=${offset}`);
        } catch (err) {
          const current = await this.retryCounter.increment(this.retryScope, partition, offset);
          log.error(`[shopflo-bronze] write error (attempt ${current}/${MAX_RETRY}) partition=${partition} offset=${offset}`, { err });

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
              log.warn(`[shopflo-bronze] DLQ (max retry) partition=${partition} offset=${offset}`);
            } catch (dlqErr) {
              log.error('[shopflo-bronze] DLQ produce failed — not committing offset', { err: dlqErr });
            }
          }
          if (current < MAX_RETRY) throw err; // KafkaJS redelivers without committing
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
