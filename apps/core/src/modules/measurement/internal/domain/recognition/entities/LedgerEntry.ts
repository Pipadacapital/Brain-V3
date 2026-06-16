/**
 * LedgerEntry — value object representing one row in realized_revenue_ledger.
 * amount_minor is BIGINT (bigint in TS — I-S07). No floats.
 * SIGNED: positive for sales/finalization, negative for reversals.
 * billing_posted_period derived from occurred_at ('YYYY-MM') per D-2 M1 binding.
 */

import { type Money } from '@brain/money';
import {
  type RecognitionEventType,
  type RecognitionLabel,
} from '../value-objects/RecognitionEvent.js';

export interface LedgerEntry {
  readonly brandId: string;
  readonly ledgerEventId: string;            // deterministic SHA-256
  readonly orderId: string;
  readonly brainId: string | null;           // UUID ref; never PII
  readonly eventType: RecognitionEventType;
  readonly money: Money;                     // amount_minor + currency_code via @brain/money
  readonly roundingAdjustmentMinor: bigint;  // D-7 banker's rounding delta (I-S07)
  readonly occurredAt: Date;                 // event-time (dual-date #1)
  readonly economicEffectiveAt: Date;        // economic-time; as-of math (dual-date #2)
  readonly billingPostedPeriod: string;      // 'YYYY-MM' from occurred_at (D-2)
  readonly recognitionLabel: RecognitionLabel;
  readonly rawEventId: string | null;        // Bronze provenance
}

/**
 * Derive billing_posted_period from a Date.
 * Format: 'YYYY-MM' (e.g. '2026-06'). Uses UTC month to be timezone-consistent
 * with the DB index expression timezone('UTC', occurred_at)::date.
 */
export function toBillingPostedPeriod(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}
