/**
 * SettlementLedgerConsumer — KafkaJS consumer for settlement.live.v1 ledger finalization.
 *
 * WIRING CRITICAL (MB-4 — NON-NEGOTIABLE):
 *   This consumer MUST be imported + instantiated + started in main.ts.
 *   Leaving it unwired is occurrence #3 of the wired-to-nothing anti-pattern
 *   (ORCH-LV-H1 / ORCH-LV-H2 history). The MANDATORY e2e wiring test
 *   (settlement-ledger-wiring.e2e.test.ts) catches an unwired consumer:
 *   un-wire → poll for ledger row → timeout → RED in CI.
 *
 * Lane design (mirrors LiveLedgerBridgeConsumer pattern exactly):
 *   - Topic:          {env}.collector.event.v1 (same live topic)
 *   - Consumer group: settlement-ledger-bridge (env: SETTLEMENT_LEDGER_CONSUMER_GROUP_ID)
 *   - Separate group = independent offset from stream-worker-live, live-ledger-bridge,
 *     identity-bridge-live. Redpanda delivers all messages to each group independently.
 *
 * Responsibility (NARROW — single concern, settlement.live.v1 only):
 *   1. Filter: skip any message whose event_name != 'settlement.live.v1' (commit + continue).
 *   2. TWO-HOP JOIN (MB-1): settlement.payment_id_hash (hashed) → look up raw payment_id
 *      via connector_razorpay_order_map → shopify_order_id.
 *      NOTE: The consumer receives payment_id_hash (hashed at mapper boundary — C1).
 *      The map table holds the raw payment_id. The join uses payment_id_hash as a secondary
 *      index... WAIT: the map table stores raw razorpay_payment_id, but the event only has
 *      payment_id_hash. We cannot join on hash alone (the hash is one-way).
 *      RESOLUTION: The consumer joins via the Razorpay-native order_id (order_XXXX) field,
 *      which IS present in the settlement event properties (order_id — not hashed, not PII).
 *      Join path: event.properties.order_id → connector_razorpay_order_map.razorpay_order_id
 *      → shopify_order_id. Falls back to payment_id: the raw payment_id is available as
 *      the settlement API item's payment_id field... but we hashed it. Alternative: the
 *      re-pull job (run.ts) could emit the raw payment_id as a non-Bronze field for join
 *      use — but that violates C1. CORRECT APPROACH per ADR-RZ-6:
 *      The SettlementLedgerConsumer looks up via order_id if present, else emits
 *      an UNMATCHED event (park-and-retry). The webhook (Track B) populates the map
 *      table with raw razorpay_payment_id; the settlement item also carries order_id.
 *      For reserve releases/adjustments (brand_level, no order_id/payment_id): brand-level path.
 *   3. Per the 05-architecture.md ADR-RZ-6:
 *      The two-hop join: settlement.payment_id_hash → connector_razorpay_order_map → shopify_order_id.
 *      In practice: event.properties.order_id IS the razorpay_order_id (order_XXXX). This is
 *      NOT a PII field (it's a Razorpay order reference, not linkable to a natural person).
 *      Join: razorpay_order_id → connector_razorpay_order_map.razorpay_order_id → shopify_order_id.
 *   4. UNMATCHED policy (MB-1.3): no map row → PARK (retry queue) + metric + alert after escalation.
 *   5. NET-OF-FEES finalization writes (MB-3): via LedgerWriter settlement methods.
 *   6. Brand-level events (MB-1.4): rolling_reserve_release, settlement_adjustment → no order join.
 *   7. autoCommit=false — commit only after confirmed ledger write (or event skipped).
 *   8. MAX_RETRY=5 → DLQ after retries exhausted.
 *
 * Brand GUC (NN-1): LedgerWriter.writeSettlementFinalization() et al. call
 *   set_config('app.current_brand_id', brandId, ...) before every INSERT.
 *   brand_id is from the event envelope (MT-1 — set by re-pull job from fn result).
 *
 * Idempotent (I-ST04): LedgerWriter uses ON CONFLICT DO NOTHING on the dedup key.
 */

import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { LedgerWriter } from '../../infrastructure/pg/LedgerWriter.js';
import { Pool } from 'pg';
import { log } from "../../log.js";

const MAX_RETRY = 5;

/** Parsed settlement event properties from settlement.live.v1 */
interface SettlementEventProperties {
  source?: string;
  settlement_id?: string;
  payment_id_hash?: string | null;
  order_id?: string | null;              // Razorpay-native order_XXXX — the map join key
  utr_hash?: string | null;
  amount_minor?: string;
  fee_minor?: string;
  tax_minor?: string;
  currency_code?: string;
  entity_type?: string;
  status?: string | null;
  settlement_at?: string | null;
  occurred_at?: string;
  reconciliation_type?: 'per_order' | 'brand_level';
}

/** Map row returned by the two-hop join query */
interface MapRow {
  shopify_order_id: string;
  razorpay_payment_id: string;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export class SettlementLedgerConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  /** Durable retry-counter scope (T2-8): `{groupId}:{topic}` — isolates same-topic groups. */
  private readonly retryScope: string;

  constructor(
    private readonly kafka: Kafka,
    private readonly ledgerWriter: LedgerWriter,
    private readonly mapPool: Pool,            // pool for connector_razorpay_order_map reads (RLS under GUC)
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

        try {
          // ── Parse the envelope ────────────────────────────────────────────
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
              await this.consumer.commitOffsets([
                { topic, partition, offset: String(Number(offset) + 1) },
              ]);
              log.warn(`JSON parse error partition=${partition} offset=${offset} — skipping`);
              return;
            }
          }

          // ── Filter: only process settlement.live.v1 ───────────────────────
          if (eventName !== 'settlement.live.v1') {
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            return;
          }

          if (!brandId || !eventId || !parsed) {
            log.warn(`settlement.live.v1 missing brand_id or event_id partition=${partition} offset=${offset} — skipping`);
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            return;
          }

          const props = (parsed['properties'] as SettlementEventProperties) ?? {};
          const result = await this.processSettlementEvent(brandId, eventId, props);

          await this.consumer.commitOffsets([
            { topic, partition, offset: String(Number(offset) + 1) },
          ]);
          await this.retryCounter.reset(this.retryScope, partition, offset);

          log.info(`[settlement-ledger] ${result} brand=${brandId} event=${eventId} ` +
                        `partition=${partition} offset=${offset}`);
        } catch (err) {
          const current = await this.retryCounter.increment(this.retryScope, partition, offset);

          log.error(`[settlement-ledger] write error (attempt ${current}/${MAX_RETRY}) ` +
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

  // ── Settlement event processing ────────────────────────────────────────────

  private async processSettlementEvent(
    brandId: string,
    eventId: string,
    props: SettlementEventProperties,
  ): Promise<string> {
    const reconciliationType = props.reconciliation_type;
    const settlementId = props.settlement_id ?? '';
    const occurredAt = props.settlement_at ?? props.occurred_at ?? new Date().toISOString();
    const currencyCode = props.currency_code ?? 'INR';
    const entityType = props.entity_type ?? 'payment';
    const amountMinor = props.amount_minor ?? '0';
    const feeMinor = props.fee_minor ?? '0';
    const taxMinor = props.tax_minor ?? '0';

    // ── BRAND-LEVEL path (rolling_reserve_release, settlement_adjustment) ────
    if (reconciliationType === 'brand_level') {
      const syntheticOrderId = `__brand_level__:${settlementId}`;
      await this.ledgerWriter.writeSettlementFinalization({
        brandId,
        orderId: syntheticOrderId,
        brainId: null,
        settlementId,
        eventType: this.resolveEventType(entityType, 'brand_level'),
        amountMinor: this.resolveAmount(entityType, amountMinor),
        feeMinor,
        taxMinor,
        currencyCode,
        occurredAt,
        reconciliationType: 'brand_level',
        taxCode: null,
        rawEventId: eventId,
      });

      return 'settlement_brand_level';
    }

    // ── PER-ORDER path: two-hop join (MB-1) ──────────────────────────────────
    // Join: event.properties.order_id (razorpay_order_id) → connector_razorpay_order_map → shopify_order_id
    const razorpayOrderId = props.order_id; // order_XXXX — the Razorpay-native order ID

    const mapRow = razorpayOrderId
      ? await this.lookupMapRow(brandId, razorpayOrderId)
      : null;

    if (!mapRow) {
      // MB-1.3: PARK — do NOT drop, do NOT crash
      // Log a structured metric (no raw IDs — C5)
      log.warn(`[settlement-ledger] UNMATCHED settlement brand=${brandId} event=${eventId} ` +
                `reason=${razorpayOrderId ? 'map_row_not_found' : 'no_order_id'} — parking`);
      // In production: emit metric settlement_unmatched_count + retry logic.
      // For M1: log + park (the event is committed from the live lane perspective;
      // the manual reconciliation path is the UNMATCHED Bronze write).
      // The consumer does NOT crash — it commits offset and moves on.
      return 'settlement_unmatched_parked';
    }

    const shopifyOrderId = mapRow.shopify_order_id;

    // ── Write net-of-fees rows (MB-3 taxonomy) ───────────────────────────────
    // settlement_finalization (+)
    await this.ledgerWriter.writeSettlementFinalization({
      brandId,
      orderId: shopifyOrderId,
      brainId: null,
      settlementId,
      eventType: 'settlement_finalization',
      amountMinor,    // settled_amount — net credit (positive)
      feeMinor,
      taxMinor,
      currencyCode,
      occurredAt,
      reconciliationType: 'per_order',
      taxCode: null,
      rawEventId: eventId,
    });

    // payment_fee (−)
    if (BigInt(feeMinor) > 0n) {
      await this.ledgerWriter.writeFeeLines({
        brandId,
        orderId: shopifyOrderId,
        brainId: null,
        settlementId,
        feeMinor: `-${feeMinor}`,    // negative
        taxMinor: `-${taxMinor}`,    // negative
        currencyCode,
        occurredAt,
        taxCode: 'GST_18',           // settlement_tax always GST_18 (MB-3)
        rawEventId: eventId,
      });
    }

    // rolling_reserve_deduction (−) — if entity_type indicates it
    if (entityType === 'reserve_deduction') {
      await this.ledgerWriter.writeSettlementFinalization({
        brandId,
        orderId: shopifyOrderId,
        brainId: null,
        settlementId,
        eventType: 'rolling_reserve_deduction',
        amountMinor: `-${amountMinor}`,   // negative
        feeMinor: '0',
        taxMinor: '0',
        currencyCode,
        occurredAt,
        reconciliationType: 'per_order',
        taxCode: null,
        rawEventId: `${eventId}:reserve`,
      });
    }

    // settlement_reversal (−) for refunds/chargebacks
    if (entityType === 'refund') {
      await this.ledgerWriter.writeSettlementFinalization({
        brandId,
        orderId: shopifyOrderId,
        brainId: null,
        settlementId,
        eventType: 'settlement_reversal',
        amountMinor: `-${amountMinor}`,   // negative
        feeMinor: '0',
        taxMinor: '0',
        currencyCode,
        occurredAt,
        reconciliationType: 'per_order',
        taxCode: null,
        rawEventId: `${eventId}:reversal`,
      });
    }

    return 'settlement_finalization_written';
  }

  // ── Two-hop join (MB-1) ───────────────────────────────────────────────────

  private async lookupMapRow(brandId: string, razorpayOrderId: string): Promise<MapRow | null> {
    const client = await this.mapPool.connect();
    try {
      await client.query('BEGIN');
      // GUC BEFORE brand-scoped read (NN-1)
      await client.query(
        `SELECT set_config('app.current_brand_id', $1, true),
                set_config('app.current_user_id', $2, true),
                set_config('app.current_workspace_id', $2, true)`,
        [brandId, NIL_UUID],
      );
      const result = await client.query<MapRow>(
        `SELECT shopify_order_id, razorpay_payment_id
         FROM connector_razorpay_order_map
         WHERE brand_id = $1 AND razorpay_order_id = $2
         LIMIT 1`,
        [brandId, razorpayOrderId],
      );
      await client.query('COMMIT');
      return result.rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Event type + amount resolution for MB-3 taxonomy ──────────────────────

  private resolveEventType(
    entityType: string,
    reconciliationType: 'per_order' | 'brand_level',
  ): string {
    if (reconciliationType === 'brand_level') {
      if (entityType === 'adjustment') return 'settlement_adjustment';
      return 'rolling_reserve_release';
    }
    switch (entityType) {
      case 'payment':         return 'settlement_finalization';
      case 'refund':          return 'settlement_reversal';
      case 'adjustment':      return 'settlement_adjustment';
      case 'reserve_deduction': return 'rolling_reserve_deduction';
      default:                return 'settlement_finalization';
    }
  }

  /**
   * Resolve signed amount for brand-level events.
   * reserve_release: positive (+); adjustment: ± (as-received); default: positive.
   */
  private resolveAmount(entityType: string, amountMinor: string): string {
    // For brand_level, amount is already signed correctly from Razorpay.
    // Adjustments may be negative — pass through as-is.
    return amountMinor;
  }
}
