/**
 * ShipmentLedgerConsumer — KafkaJS consumer for logistics shipment events → CoD/RTO ledger.
 *
 * GENERALIZED from GokwikAwbLedgerConsumer (SPEC 3): it now handles EVERY logistics source on the
 * shared logistics canonical surface — GoKwik AWB (`gokwik.awb_status.v1`) AND Shiprocket shipment
 * tracking (`shiprocket.shipment_status.v1`). Both mappers emit the SAME property shape
 * (terminal_class / is_terminal / payment_method / order_id), classified by the SINGLE shared
 * authority @brain/logistics-status — so one consumer, one deterministic ledger mapping, no drift.
 * (A back-compat alias `GokwikAwbLedgerConsumer` is exported below.)
 *
 * CROSS-SOURCE DOUBLE-BOOKING GUARD: if BOTH GoKwik and Shiprocket report a terminal RTO for the
 * same order, the LedgerWriter dedup key (brand_id, order_id, event_type, date) + ON CONFLICT DO
 * NOTHING ensures the cod_rto_clawback is written EXACTLY ONCE. The two sources cannot double-claw.
 *
 * WIRING CRITICAL (mirrors SettlementLedgerConsumer):
 *   This consumer MUST be imported + instantiated + started in main.ts. An unwired consumer is the
 *   wired-to-nothing anti-pattern — the gokwik-awb-ledger wiring e2e catches it (un-wire → poll for
 *   ledger row → timeout → RED in CI).
 *
 * Lane design:
 *   - Topic:          {env}.collector.event.v1 (same live topic)
 *   - Consumer group: gokwik-awb-ledger-bridge (env: GOKWIK_AWB_LEDGER_CONSUMER_GROUP_ID)
 *   - Separate group = independent offset from the other live consumers.
 *
 * Responsibility (NARROW — logistics shipment terminal states only):
 *   1. Filter: skip any message whose event_name is not a logistics shipment event (commit + continue).
 *   2. Only act on TERMINAL transitions (is_terminal=true). Non-terminal transitions are lifecycle
 *      provenance in Bronze — they do not move the ledger.
 *   3. terminal_class='rto'       → cod_rto_clawback: look up recognized CoD amount, write signed-NEGATIVE.
 *      terminal_class='delivered' → cod_delivery_confirmed: write a 0-amount provenance row.
 *      terminal_class='other'     → no ledger effect in Slice 1 (commit + continue).
 *   4. payment_method gate: only CoD orders get a clawback (a prepaid RTO is a fulfilment event, not
 *      a CoD-revenue reversal). Unknown payment_method still claws back on RTO (conservative) but only
 *      if the recognized amount is > 0.
 *   5. autoCommit=false — commit only after the confirmed ledger write (or skip).
 *   6. MAX_RETRY=5 → DLQ after retries exhausted.
 *
 * Idempotent restatement (I-ST04): the re-pull re-emits the same terminal transition with the same
 * event_id; the LedgerWriter dedup key ensures the clawback is written exactly once.
 *
 * brand_id is from the event envelope (MT-1 — set by the re-pull job from the enumeration fn).
 */

import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { extractKafkaTraceContext } from '@brain/observability';
import { context } from '@opentelemetry/api';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { LedgerWriter } from '../../infrastructure/pg/LedgerWriter.js';
import { log } from "../../log.js";

const MAX_RETRY = 5;

/** Logistics shipment events this consumer acts on (shared canonical surface). */
const SHIPMENT_EVENT_NAMES = new Set<string>([
  'gokwik.awb_status.v1',
  'shiprocket.shipment_status.v1',
]);

interface ShipmentEventProperties {
  source?: string;
  data_source?: string;
  awb_number_hash?: string | null;
  order_id?: string;
  status?: string;
  terminal_class?: 'rto' | 'delivered' | 'other' | 'none';
  is_terminal?: boolean;
  payment_method?: 'cod' | 'prepaid' | null;
  pincode?: string | null;
  courier?: string | null;
  status_changed_at?: string;
  occurred_at?: string;
}

export class ShipmentLedgerConsumer {
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

        // Resume producer trace context across the Kafka boundary (observability skill).
        const traceCtx = extractKafkaTraceContext(
          (message.headers ?? {}) as Record<string, Buffer | string | undefined>,
        );

        return context.with(traceCtx, async () => {
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
              log.warn(`JSON parse error partition=${partition} offset=${offset} — skipping`);
              return;
            }
          }

          if (!eventName || !SHIPMENT_EVENT_NAMES.has(eventName)) {
            await this.commit(topic, partition, offset);
            return;
          }

          if (!brandId || !eventId || !parsed) {
            log.warn(`missing brand_id or event_id partition=${partition} offset=${offset} — skipping`);
            await this.commit(topic, partition, offset);
            return;
          }

          const props = (parsed['properties'] as ShipmentEventProperties) ?? {};
          const result = await this.processShipmentEvent(brandId, eventId, props);

          await this.commit(topic, partition, offset);
          await this.retryCounter.reset(this.retryScope, partition, offset);
          log.info(`${result} source=${props.source ?? '?'} brand=${brandId} event=${eventId} partition=${partition} offset=${offset}`);
        } catch (err) {
          const current = await this.retryCounter.increment(this.retryScope, partition, offset);
          log.error(`write error (attempt ${current}/${MAX_RETRY}) partition=${partition} offset=${offset}`, { err: err });

          if (current >= MAX_RETRY) {
            try {
              await this.dlqProducer.send(
                `${topic}.dlq`,
                message.key?.toString() ?? null,
                message.value,
                `max_retry_exceeded: ${String(err)}`,
              );
              await this.commit(topic, partition, offset);
              await this.retryCounter.reset(this.retryScope, partition, offset);
              log.warn(`DLQ (max retry) partition=${partition} offset=${offset}`);
            } catch (dlqErr) {
              log.error('DLQ produce failed — not committing offset', { err: dlqErr });
            }
          }
          if (current < MAX_RETRY) throw err;
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

  private async commit(topic: string, partition: number, offset: string): Promise<void> {
    await this.consumer.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
  }

  // ── Shipment terminal-state → ledger (shared GoKwik + Shiprocket) ───────────

  private async processShipmentEvent(
    brandId: string,
    eventId: string,
    props: ShipmentEventProperties,
  ): Promise<string> {
    if (!props.is_terminal) {
      return 'shipment_non_terminal_skipped';
    }

    const orderId = props.order_id ?? '';
    if (!orderId) {
      return 'shipment_no_order_id_skipped';
    }

    const occurredAt = props.status_changed_at ?? props.occurred_at ?? new Date().toISOString();
    const terminalClass = props.terminal_class ?? 'none';

    if (terminalClass === 'rto') {
      // Only CoD revenue is clawed back. A prepaid RTO is a fulfilment event, not a CoD reversal.
      if (props.payment_method === 'prepaid') {
        return 'shipment_rto_prepaid_no_clawback';
      }
      const recognizedMinor = await this.ledgerWriter.lookupRecognizedAmountMinor(brandId, orderId);
      if (BigInt(recognizedMinor) <= 0n) {
        // Nothing recognized for this order → nothing to claw back.
        return 'shipment_rto_no_recognized_amount';
      }
      const clawbackMinor = `-${recognizedMinor}`;   // signed-negative reversal
      // Dedup key (brand,order,event_type,date) guards against GoKwik + Shiprocket double-booking
      // the same order's RTO → written exactly once.
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

    // terminal_class === 'other' (Cancelled/Lost/Damaged/Destroyed/Disposed) — no ledger effect in Slice 1.
    return 'shipment_terminal_other_skipped';
  }
}

/**
 * Back-compat alias. The consumer was introduced as GokwikAwbLedgerConsumer and is wired under that
 * name in main.ts + guarded by gokwik-awb-ledger-wiring.e2e.test.ts. It now handles all logistics
 * sources (see ShipmentLedgerConsumer above); the alias keeps existing imports working.
 */
export const GokwikAwbLedgerConsumer = ShipmentLedgerConsumer;
export type GokwikAwbLedgerConsumer = ShipmentLedgerConsumer;
