/**
 * RecognitionPolicy — pure domain logic (no I/O).
 * Maps a RecognitionEvent to a LedgerEntry.
 * All money via @brain/money; no floats; no raw arithmetic on money (I-S07).
 *
 * Recognition label rules (architecture D-3):
 *   provisional_recognition → 'provisional'
 *   finalization            → 'finalized'
 *   reversals               → 'finalized' (they restate finalized truth)
 *   'settling' reserved for settlement connector (later slice)
 */

import { money, type CurrencyCode } from '@brain/money';
import { type RecognitionEvent, type RecognitionLabel } from '../value-objects/RecognitionEvent.js';
import { type LedgerEntry, toBillingPostedPeriod } from '../entities/LedgerEntry.js';
import { computeLedgerEventId } from '../services/LedgerEventId.js';

function toLabel(eventType: RecognitionEvent['eventType']): RecognitionLabel {
  if (eventType === 'provisional_recognition') return 'provisional';
  if (eventType === 'finalization') return 'finalized';
  // All reversal types are finalized truth
  return 'finalized';
}

/**
 * Apply recognition policy: RecognitionEvent → LedgerEntry.
 * Pure function — no I/O, no side effects.
 * roundingAdjustmentMinor defaults to 0n (no rounding in this path — D-7).
 */
export function applyRecognitionPolicy(
  event: RecognitionEvent,
  roundingAdjustmentMinor: bigint = 0n,
): LedgerEntry {
  const ledgerEventId = computeLedgerEventId({
    brandId: event.brandId,
    orderId: event.orderId,
    eventType: event.eventType,
    sourcePk: event.sourcePk,
  });

  const entryMoney = money(event.amountMinor, event.currencyCode as CurrencyCode);

  return Object.freeze({
    brandId: event.brandId,
    ledgerEventId,
    orderId: event.orderId,
    brainId: event.brainId,
    eventType: event.eventType,
    money: entryMoney,
    roundingAdjustmentMinor,
    occurredAt: event.occurredAt,
    economicEffectiveAt: event.economicEffectiveAt,
    billingPostedPeriod: toBillingPostedPeriod(event.occurredAt),
    recognitionLabel: toLabel(event.eventType),
    rawEventId: event.rawEventId,
    paymentMethod: event.paymentMethod ?? null, // persisted for finalization (0097 / GAP-2 residual)
  });
}
