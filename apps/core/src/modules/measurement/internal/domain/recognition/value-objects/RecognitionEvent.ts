/**
 * RecognitionEvent — the canonical input to the recognition domain.
 * Carries all data needed to produce a LedgerEntry without I/O.
 * No PII — brain_id is a UUID reference only.
 */

export type RecognitionEventType =
  | 'provisional_recognition'
  | 'finalization'
  | 'rto_reversal'
  | 'refund'
  | 'chargeback'
  | 'cancellation'
  | 'settlement_fee_reversal'
  | 'marketplace_adjustment'
  | 'payment_adjustment'
  | 'concession';

export type RecognitionLabel = 'provisional' | 'settling' | 'finalized';

export type PaymentMethod = 'cod' | 'prepaid';

export interface RecognitionEvent {
  readonly brandId: string;
  readonly orderId: string;
  readonly brainId: string | null;          // UUID ref; null if not resolved
  readonly eventType: RecognitionEventType;
  readonly amountMinor: bigint;             // SIGNED; negative for reversals (I-S07)
  readonly currencyCode: string;            // CHAR(3)
  readonly occurredAt: Date;                // event-time (dual-date #1)
  readonly economicEffectiveAt: Date;       // economic-time; drives as-of math (dual-date #2)
  readonly paymentMethod: PaymentMethod;
  readonly sourcePk: string;               // upstream PK for deterministic ledger_event_id
  readonly rawEventId: string | null;       // Bronze event_id provenance
}
