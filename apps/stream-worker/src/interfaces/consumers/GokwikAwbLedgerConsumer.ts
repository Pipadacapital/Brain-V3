/**
 * GokwikAwbLedgerConsumer — KafkaJS consumer for gokwik.awb_status.v1 → CoD/RTO ledger.
 *
 * WIRING CRITICAL (mirrors SettlementLedgerConsumer):
 *   This consumer MUST be imported + instantiated + started in main.ts. An unwired consumer
 *   is the wired-to-nothing anti-pattern — the gokwik-awb-ledger wiring e2e catches it (un-wire
 *   → poll for ledger row → timeout → RED in CI).
 *
 * Lane design (mirrors SettlementLedgerConsumer exactly):
 *   - Topic:          {env}.collector.event.v1 (same live topic)
 *   - Consumer group: gokwik-awb-ledger-bridge (env: GOKWIK_AWB_LEDGER_CONSUMER_GROUP_ID)
 *   - Separate group = independent offset from the other live consumers.
 *
 * Responsibility (NARROW — gokwik.awb_status.v1 only):
 *   1. Filter: skip any message whose event_name != 'gokwik.awb_status.v1' (commit + continue).
 *   2. Only act on TERMINAL transitions (is_terminal=true). Non-terminal transitions are
 *      lifecycle provenance in Bronze — they do not move the ledger.
 *   3. terminal_class='rto'      → cod_rto_clawback: look up the recognized CoD amount for the
 *                                  order, write a signed-NEGATIVE clawback (reverses recognition).
 *      terminal_class='delivered' → cod_delivery_confirmed: write a 0-amount provenance row.
 *      terminal_class='other'     → no ledger effect in Slice 1 (commit + continue).
 *   4. payment_method gate: only CoD orders get a clawback (a prepaid RTO is a fulfilment event,
 *      not a CoD-revenue reversal). If payment_method is unknown, we still clawback on RTO
 *      (conservative — recognized CoD revenue must not survive a confirmed RTO) but ONLY if the
 *      recognized amount is > 0; a 0 recognized amount writes nothing.
 *   5. autoCommit=false — commit only after the confirmed ledger write (or skip).
 *   6. MAX_RETRY=5 → DLQ after retries exhausted.
 *
 * Idempotent restatement (I-ST04): the re-pull re-emits the same terminal transition with the
 * same event_id; the LedgerWriter dedup key (brand_id, order_id, event_type, date) +
 * ON CONFLICT DO NOTHING ensures the clawback is written exactly once.
 *
 * brand_id is from the event envelope (MT-1 — set by the re-pull job from the fn result).
 */

import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import { LedgerWriter } from '../../infrastructure/pg/LedgerWriter.js';

const MAX_RETRY = 5;
type RetryKey = string;

interface AwbEventProperties {
  source?: string;
  data_source?: string;
  awb_number_hash?: string | null;
  order_id?: string;
  status?: string;
  terminal_class?: 'rto' | 'delivered' | 'other' | 'none';
  is_terminal?: boolean;
  payment_method?: 'cod' | 'prepaid' | null;
  pincode?: string | null;
  status_changed_at?: string;
  occurred_at?: string;
}

export class GokwikAwbLedgerConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  private readonly retryCount = new Map<RetryKey, number>();

  constructor(
    private readonly kafka: Kafka,
    private readonly ledgerWriter: LedgerWriter,
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

        try {
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
              await this.commit(topic, partition, offset);
              console.warn(`[gokwik-awb-ledger] JSON parse error partition=${partition} offset=${offset} — skipping`);
              return;
            }
          }

          if (eventName !== 'gokwik.awb_status.v1') {
            await this.commit(topic, partition, offset);
            return;
          }

          if (!brandId || !eventId || !parsed) {
            console.warn(`[gokwik-awb-ledger] missing brand_id or event_id partition=${partition} offset=${offset} — skipping`);
            await this.commit(topic, partition, offset);
            return;
          }

          const props = (parsed['properties'] as AwbEventProperties) ?? {};
          const result = await this.processAwbEvent(brandId, eventId, props);

          await this.commit(topic, partition, offset);
          this.retryCount.delete(retryKey);
          console.info(`[gokwik-awb-ledger] ${result} brand=${brandId} event=${eventId} partition=${partition} offset=${offset}`);
        } catch (err) {
          const current = (this.retryCount.get(retryKey) ?? 0) + 1;
          this.retryCount.set(retryKey, current);
          console.error(`[gokwik-awb-ledger] write error (attempt ${current}/${MAX_RETRY}) partition=${partition} offset=${offset}`, err);

          if (current >= MAX_RETRY) {
            try {
              await this.dlqProducer.send(
                `${topic}.dlq`,
                message.key?.toString() ?? null,
                message.value,
                `max_retry_exceeded: ${String(err)}`,
              );
              await this.commit(topic, partition, offset);
              this.retryCount.delete(retryKey);
              console.warn(`[gokwik-awb-ledger] DLQ (max retry) partition=${partition} offset=${offset}`);
            } catch (dlqErr) {
              console.error('[gokwik-awb-ledger] DLQ produce failed — not committing offset', dlqErr);
            }
          }
          if (current < MAX_RETRY) throw err;
        }
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.stop();
    await this.consumer.disconnect();
    await this.dlqProducer.disconnect();
  }

  private async commit(topic: string, partition: number, offset: string): Promise<void> {
    await this.consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
  }

  // ── AWB terminal-state → ledger ────────────────────────────────────────────

  private async processAwbEvent(
    brandId: string,
    eventId: string,
    props: AwbEventProperties,
  ): Promise<string> {
    if (!props.is_terminal) {
      return 'awb_non_terminal_skipped';
    }

    const orderId = props.order_id ?? '';
    if (!orderId) {
      return 'awb_no_order_id_skipped';
    }

    const occurredAt = props.status_changed_at ?? props.occurred_at ?? new Date().toISOString();
    const terminalClass = props.terminal_class ?? 'none';

    if (terminalClass === 'rto') {
      // Only CoD revenue is clawed back. A prepaid RTO is a fulfilment event, not a CoD reversal.
      if (props.payment_method === 'prepaid') {
        return 'awb_rto_prepaid_no_clawback';
      }
      const recognizedMinor = await this.ledgerWriter.lookupRecognizedAmountMinor(brandId, orderId);
      if (BigInt(recognizedMinor) <= 0n) {
        // Nothing recognized for this order → nothing to claw back.
        return 'awb_rto_no_recognized_amount';
      }
      const clawbackMinor = `-${recognizedMinor}`;   // signed-negative reversal
      const inserted = await this.ledgerWriter.writeCodLedgerEvent({
        brandId,
        orderId,
        eventType: 'cod_rto_clawback',
        amountMinor: clawbackMinor,
        currencyCode: 'INR',
        occurredAt,
        rawEventId: eventId,
      });
      return inserted ? 'cod_rto_clawback_written' : 'cod_rto_clawback_deduped';
    }

    if (terminalClass === 'delivered') {
      const inserted = await this.ledgerWriter.writeCodLedgerEvent({
        brandId,
        orderId,
        eventType: 'cod_delivery_confirmed',
        amountMinor: '0',           // provenance marker — does not move realized GMV
        currencyCode: 'INR',
        occurredAt,
        rawEventId: eventId,
      });
      return inserted ? 'cod_delivery_confirmed_written' : 'cod_delivery_confirmed_deduped';
    }

    // terminal_class === 'other' (Cancelled/Lost/Damaged/Returned) — no ledger effect in Slice 1.
    return 'awb_terminal_other_skipped';
  }
}
