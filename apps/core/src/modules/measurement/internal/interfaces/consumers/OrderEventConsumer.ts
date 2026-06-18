/**
 * OrderEventConsumer — Bronze order event → RecognizeOrder command.
 * Idempotent: offset committed only after successful DB write (offset-after-write).
 * All money as bigint (never float, I-S07). No PII in payloads written.
 *
 * In M1 this is a thin adapter; the Kafka/Redpanda consumer wiring
 * is the stream-worker's responsibility. This class handles the
 * domain translation only.
 */

import { type Pool } from 'pg';
import { RecognizeOrderCommand } from '../../application/commands/RecognizeOrder.js';
import {
  type RecognitionEvent,
  type PaymentMethod,
} from '../../domain/recognition/value-objects/RecognitionEvent.js';

export interface RawOrderEvent {
  brand_id: string;
  order_id: string;
  brain_id: string | null;
  amount_minor: bigint | string | number; // normalized to bigint below
  currency_code: string;
  occurred_at: string;                   // ISO-8601
  payment_method: string;
  source_pk: string;
  raw_event_id: string | null;
}

function toPaymentMethod(raw: string): PaymentMethod {
  if (raw === 'cod') return 'cod';
  return 'prepaid';
}

function toBigInt(v: bigint | string | number): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string') return BigInt(v);
  // number: must be integer (no float money — I-S07)
  if (!Number.isInteger(v)) {
    throw new Error(`[OrderEventConsumer] float amount_minor forbidden: ${v} (I-S07)`);
  }
  return BigInt(Math.trunc(v));
}

/**
 * Optional attribution clawback hook (Phase 5). When a reversal event is processed,
 * the consumer invokes this AFTER the revenue reversal is appended so the attribution
 * ledger appends mirrored signed-negative clawback rows (SAVED weights, idempotent).
 * Injected by the composition root; absent in pre-Phase-5 wiring (additive, I-E05).
 */
export interface AttributionReversalHook {
  onRevenueReversal(reversal: {
    brandId: string;
    orderId: string;
    reversalReason: 'rto_reversal' | 'refund' | 'chargeback' | 'cancellation' | 'concession';
    reversalLedgerEventId: string;
    /** The (negative) reversal basis in signed minor units. */
    reversalBasisMinor: bigint;
    occurredAt: Date;
  }): Promise<void>;
}

export class OrderEventConsumer {
  private readonly recognizeOrder: RecognizeOrderCommand;

  constructor(
    pool: Pool,
    private readonly attributionHook?: AttributionReversalHook,
  ) {
    this.recognizeOrder = new RecognizeOrderCommand(pool);
  }

  /**
   * Process a reversal event. The revenue reversal is the measurement module's job (the
   * caller appends it via PostReversalCommand); this entrypoint fans the SAME reversal out
   * to the attribution clawback (Phase 5) when the hook is wired. Idempotent end-to-end
   * (deterministic reversal id → ON CONFLICT DO NOTHING). No-op when no hook is injected.
   */
  async handleReversal(reversal: {
    brandId: string;
    orderId: string;
    reversalReason: 'rto_reversal' | 'refund' | 'chargeback' | 'cancellation' | 'concession';
    reversalLedgerEventId: string;
    reversalBasisMinor: bigint;
    occurredAt: Date;
  }): Promise<void> {
    if (this.attributionHook) {
      await this.attributionHook.onRevenueReversal(reversal);
    }
  }

  /**
   * Process a raw Bronze order event into a provisional_recognition ledger row.
   * Idempotent: ON CONFLICT DO NOTHING in the repository.
   */
  async handle(raw: RawOrderEvent): Promise<void> {
    const occurredAt = new Date(raw.occurred_at);
    const event: RecognitionEvent = {
      brandId: raw.brand_id,
      orderId: raw.order_id,
      brainId: raw.brain_id,
      eventType: 'provisional_recognition',
      amountMinor: toBigInt(raw.amount_minor),
      currencyCode: raw.currency_code,
      occurredAt,
      economicEffectiveAt: occurredAt, // for provisional, economic_effective_at = occurred_at
      paymentMethod: toPaymentMethod(raw.payment_method),
      sourcePk: raw.source_pk,
      rawEventId: raw.raw_event_id,
    };
    await this.recognizeOrder.execute(event);
  }
}
