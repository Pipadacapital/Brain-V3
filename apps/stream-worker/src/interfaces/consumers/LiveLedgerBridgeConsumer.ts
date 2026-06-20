/**
 * LiveLedgerBridgeConsumer — KafkaJS consumer for order.live.v1 ledger recognition.
 *
 * ORCH-LV-H1 fix: this consumer is the MISSING WIRE between the live lane and the
 * ledger. Before this fix, LiveOrderConsumer.routeLiveOrderToLedger() existed and
 * was tested in isolation but was never subscribed to the Kafka topic in main.ts —
 * so 903 order.live.v1 events landed in Bronze but the ledger stayed flat.
 *
 * Lane design (mirrors IdentityBridgeConsumer pattern):
 *   - Topic:          {env}.collector.event.v1  (same live topic as CollectorEventConsumer)
 *   - Consumer group: live-ledger-bridge         (env-overridable via LIVE_LEDGER_CONSUMER_GROUP_ID)
 *   - Separate group = independent offset from stream-worker-live and identity-bridge-live.
 *     Redpanda delivers all messages to each consumer group independently.
 *
 * Responsibility (NARROW — single concern):
 *   1. Filter: skip any message whose event_name != 'order.live.v1' (commit offset, continue).
 *   2. Route: call routeLiveOrderToLedger() → writes provisional_recognition (sale) or
 *      rto_reversal (cancelled order) to realized_revenue_ledger via LedgerWriter.
 *   3. Does NOT write Bronze — CollectorEventConsumer (group: stream-worker-live) already does.
 *
 * Brand GUC (E-4 / NN-1): LedgerWriter.writeProvisionalRecognition() and writeReversal()
 *   both call set_config('app.current_brand_id', brandId, ...) before every ledger INSERT.
 *   Brand ID is extracted from the event envelope (brand_id field), never from env/headers.
 *
 * Offset-commit ordering (D-7 — same discipline as BackfillOrderConsumer):
 *   Offset committed ONLY after ledger write confirmed (or event skipped as non-order).
 *   On throw: increment retry counter, do NOT commit.
 *   After MAX_RETRY=5 for the same (partition, offset): DLQ then commit.
 *
 * Idempotent (E-5 / I-ST04): LedgerWriter uses ON CONFLICT DO NOTHING on the composite
 *   dedup key — safe to re-deliver the same event_id after a crash/restart.
 */

import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { LedgerWriter } from '../../infrastructure/pg/LedgerWriter.js';
import { routeLiveOrderToLedger, extractLiveOrderForLedger } from './LiveOrderConsumer.js';
import { log } from "../../log.js";

const MAX_RETRY = 5;

/**
 * Live attribution clawback hook (D1). On a confirmed live rto_reversal, fan the SAME reversal out
 * to the attribution ledger (mirrored signed-negative clawback, SAVED weights, idempotent). This is
 * the shared @brain/attribution-writer hook — the SAME writer the hourly reconcile job uses (no
 * dual-writer). Injected by the composition root; absent (e.g. no StarRocks) → the hourly job is the
 * sole path. Invoked BEST-EFFORT: a failure here NEVER blocks the offset commit (the ledger write is
 * already durable and the hourly reconcile job backstops any miss — idempotent ON CONFLICT).
 */
export interface LiveAttributionReversalHook {
  onRevenueReversal(reversal: {
    brandId: string;
    orderId: string;
    reversalReason: 'rto_reversal';
    reversalLedgerEventId: string;
    reversalBasisMinor: bigint;
    occurredAt: Date;
  }): Promise<void>;
}

export class LiveLedgerBridgeConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  /** Durable retry-counter scope (T2-8): `{groupId}:{topic}` — isolates same-topic groups. */
  private readonly retryScope: string;

  constructor(
    private readonly kafka: Kafka,
    private readonly ledgerWriter: LedgerWriter,
    private readonly topic: string,
    private readonly groupId: string,
    /** Durable (Redis) retry counter — survives restarts so a poison message reaches the DLQ (T2-8). */
    private readonly retryCounter: IRetryCounter,
    /** Optional live attribution clawback hook (D1) — best-effort, never blocks offset commit. */
    private readonly attributionHook?: LiveAttributionReversalHook,
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
      // autoCommit=false: commit manually ONLY after ledger write confirmed (D-7).
      autoCommit: false,

      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;
        const offset = message.offset;

        try {
          // ── Parse the envelope to check event_name + extract brand_id / event_id ──
          let parsed: Record<string, unknown> | null = null;
          let eventName: string | null = null;
          let brandId: string | undefined;
          let eventId: string | undefined;

          if (message.value) {
            try {
              parsed = JSON.parse(message.value.toString('utf8')) as Record<string, unknown>;
              eventName = typeof parsed['event_name'] === 'string' ? parsed['event_name'] : null;
              brandId = typeof parsed['brand_id'] === 'string' ? parsed['brand_id'] : undefined;
              eventId = typeof parsed['event_id'] === 'string' ? parsed['event_id'] : undefined;
            } catch {
              // Unparseable message — commit and skip (CollectorEventConsumer DLQs these)
              await this.consumer.commitOffsets([
                { topic, partition, offset: String(Number(offset) + 1) },
              ]);
              log.warn(`JSON parse error partition=${partition} offset=${offset} — skipping`);
              return;
            }
          }

          // ── Filter: only process order.live.v1 ──────────────────────────────
          if (eventName !== 'order.live.v1') {
            // Non-order event on the live lane — commit offset, nothing to do here.
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            return;
          }

          // ── Route to ledger (brand GUC set inside LedgerWriter per write) ────
          const result = await routeLiveOrderToLedger(
            message.value,
            brandId,
            eventId,
            this.ledgerWriter,
          );

          // D1: on a confirmed live reversal, fan out the attribution clawback (best-effort).
          // The ledger write above is already durable; this MUST NOT affect the offset commit,
          // so any failure is swallowed (the hourly reconcile job backstops it, idempotently).
          if (result === 'reversal' && this.attributionHook) {
            await this.fireClawbackBestEffort(message.value, brandId, eventId);
          }

          // Commit offset after confirmed ledger write (or 'skipped' for missing fields)
          await this.consumer.commitOffsets([
            { topic, partition, offset: String(Number(offset) + 1) },
          ]);
          await this.retryCounter.reset(this.retryScope, partition, offset);
          log.info(`[live-ledger-bridge] ${result} brand=${brandId} event=${eventId} ` +
                        `partition=${partition} offset=${offset}`);
        } catch (err) {
          // Ledger write error — do NOT commit offset. Increment retry counter.
          const current = await this.retryCounter.increment(this.retryScope, partition, offset);

          log.error(`[live-ledger-bridge] write error (attempt ${current}/${MAX_RETRY}) ` +
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

  /**
   * Fire the attribution clawback for a confirmed live reversal (D1). BEST-EFFORT: every failure
   * is logged and swallowed so it can never block the offset commit or trigger a retry — the ledger
   * row is already durable and the hourly reconcile job re-claws idempotently. Full RTO ⇒ the
   * reversal basis is −(order amount); reuses the pure extractor for the order fields.
   */
  private async fireClawbackBestEffort(
    value: Buffer | null,
    brandId: string | undefined,
    eventId: string | undefined,
  ): Promise<void> {
    try {
      const order = extractLiveOrderForLedger(value, brandId, eventId);
      if (!order || !this.attributionHook) return;
      await this.attributionHook.onRevenueReversal({
        brandId: order.brandId,
        orderId: order.orderId,
        reversalReason: 'rto_reversal',
        reversalLedgerEventId: order.rawEventId ?? order.sourcePk,
        reversalBasisMinor: -BigInt(order.amountMinor), // full RTO → negate the order amount
        occurredAt: new Date(order.occurredAt),
      });
    } catch (err) {
      log.warn('[live-ledger-bridge] attribution clawback failed (best-effort; reconcile job backstops)', { err });
    }
  }

  async stop(): Promise<void> {
    await this.consumer.stop();
    await this.consumer.disconnect();
    await this.dlqProducer.disconnect();
  }
}
