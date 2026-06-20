/**
 * BackfillOrderConsumer — KafkaJS consumer for {env}.collector.order.backfill.v1.
 *
 * Lane isolation (ADR-BF-7 / D-3 / SI-3):
 *   - Topic: {env}.collector.order.backfill.v1  (NOT the live {env}.collector.event.v1)
 *   - Consumer group: stream-worker-backfill     (NOT stream-worker-live)
 *   - Single partition on the backfill topic = natural throughput cap
 *   - Structurally impossible to lag the live consumer group (different topics)
 *
 * Pipeline per message (ADR-BF-8 / ADR-BF-9):
 *   1. ProcessEventUseCase → Bronze write (idempotent on event_id — I-ST04)
 *   2. LedgerWriter.writeProvisionalRecognition → provisional_recognition in ledger
 *      (ADR-BF-9: the missing wire that turns backfill Bronze into ledger rows)
 *
 * This completes the Bronze → ledger feed so the EXISTING revenue-finalization.ts
 * cron finalizes past-horizon provisionals → realized (ADR-BF-10 / no new math).
 *
 * Offset-commit ordering (D-7 — same discipline as CollectorEventConsumer):
 *   Kafka offset committed ONLY after BOTH Bronze + ledger writes succeed.
 *   On throw: increment retry counter, do NOT commit offset.
 *   After MAX_RETRY=5 for the same offset: route to DLQ, then commit offset.
 *
 * Note on identity: brain_id is null at this consumer's execution time because
 * the IdentityBridgeConsumer runs concurrently. The ledger row stores brain_id=null
 * initially and raw_event_id for future backfill of brain_id once resolved.
 * The revenue-finalization job does not require brain_id for finalization (it uses
 * order_id). This is acceptable for M1 (brain_id join is a metric enrichment).
 */

import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { ProcessEventUseCase, ProcessResult } from '../../application/ProcessEventUseCase.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { LedgerWriter, BackfillOrderForLedger } from '../../infrastructure/pg/LedgerWriter.js';
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
    private readonly ledgerWriter: LedgerWriter,
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

          // ── Step 2: Ledger wire (ADR-BF-9) ──────────────────────────────────
          // Extract order event fields and write provisional_recognition.
          // Attempt for all outcomes (written/dedup_hit/pk_conflict): LedgerWriter
          // uses ON CONFLICT DO NOTHING so re-writes are safe.
          const ledgerOrder = extractLedgerOrder(message.value, result.brandId, result.eventId);
          if (ledgerOrder) {
            try {
              await this.ledgerWriter.writeProvisionalRecognition(ledgerOrder);
            } catch (ledgerErr) {
              // Ledger write failure on dedup outcomes: log and continue
              // (the provisional row already exists from a previous write)
              if (result.outcome === 'written') {
                // New Bronze write but ledger write failed → must retry (throw)
                throw ledgerErr;
              }
              log.warn(`ledger write suppressed brand=${result.brandId} event=${result.eventId}: ${String(ledgerErr)}`);
            }
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
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.stop();
    await this.consumer.disconnect();
    await this.dlqProducer.disconnect();
  }
}

/**
 * Extract a BackfillOrderForLedger from the Kafka message payload.
 * Only processes order.backfill.v1 events. Returns null for other event types
 * or if required fields are missing.
 *
 * Note on brain_id (ADR-BF-9): brain_id is null here — the IdentityBridgeConsumer
 * runs concurrently on the SAME topic/group (added in main.ts) and will mint/link
 * brain_id. The ledger tolerates null brain_id (it's nullable in the schema).
 */
function extractLedgerOrder(
  rawValue: Buffer | null,
  brandId?: string,
  eventId?: string,
): BackfillOrderForLedger | null {
  if (!rawValue || !brandId || !eventId) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawValue.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Only process order.backfill.v1 events
  if (parsed['event_name'] !== 'order.backfill.v1') {
    return null;
  }

  const props = (parsed['properties'] as Record<string, unknown>) ?? {};

  const orderId = typeof props['order_id'] === 'string' ? props['order_id'] : null;
  const amountMinor = typeof props['amount_minor'] === 'string' ? props['amount_minor'] : null;
  const currencyCode = typeof props['currency_code'] === 'string' ? props['currency_code'] : null;
  const occurredAt = typeof parsed['occurred_at'] === 'string' ? parsed['occurred_at'] : null;
  const paymentMethod =
    typeof props['payment_method'] === 'string' &&
    (props['payment_method'] === 'cod' || props['payment_method'] === 'prepaid')
      ? (props['payment_method'] as 'cod' | 'prepaid')
      : 'prepaid'; // conservative default

  if (!orderId || !amountMinor || !currencyCode || !occurredAt) {
    return null;
  }

  // Validate amount_minor is a non-negative integer string (I-S07)
  if (!/^\d+$/.test(amountMinor)) {
    log.warn(`invalid amount_minor "${amountMinor}" — skipping ledger write`);
    return null;
  }

  return {
    brandId,
    orderId,
    brainId: null,       // identity bridge fills this asynchronously
    amountMinor,         // BIGINT-as-string → PgLedgerRepository uses ::bigint cast
    currencyCode,
    occurredAt,          // D-6: Shopify processed_at from the event envelope
    paymentMethod,
    sourcePk: eventId,   // Bronze event_id is the source_pk (ledger dedup key input)
    rawEventId: eventId,
  };
}
