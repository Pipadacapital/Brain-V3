/**
 * LiveOrderConsumer — handles order.live.v1 events from the live lane.
 *
 * Unlike BackfillOrderConsumer (which subscribes to a dedicated backfill topic),
 * this consumer DOES NOT subscribe to a new topic. Instead, it is called from
 * CollectorEventConsumer's existing eachMessage handler when the event_name is
 * 'order.live.v1'. This mirrors the architecture plan's "same code path, different
 * event_name, same lane" — the live lane (stream-worker-live) already processes
 * all events via ProcessEventUseCase → Bronze. This module adds the LEDGER wire.
 *
 * Live recognition path (ADR-LV-11 / D-13):
 *   1. order.live.v1 → Bronze (insert-if-absent on event_id — existing path)
 *   2. If cancelled_at != null → LedgerWriter.writeReversal() (new negative row)
 *   3. If cancelled_at == null → LedgerWriter.writeProvisionalRecognition()
 *      (same as backfill — provisional until finalization job runs)
 *
 * The finalization cron (revenue-finalization.ts) is unchanged — it reads
 * the ledger for past-horizon provisionals and writes finalization rows.
 * The reversal overrides the economic outcome when the order is cancelled/RTO.
 *
 * This module exports extractLiveOrderForLedger and routeLiveOrderToLedger —
 * called by CollectorEventConsumer (or a composition layer) after Bronze write.
 */

import type { LedgerWriter, BackfillOrderForLedger } from '../../infrastructure/pg/LedgerWriter.js';
import { log } from "../../log.js";

/**
 * Extract a BackfillOrderForLedger from a parsed live order event envelope.
 * Only processes 'order.live.v1' events. Returns null for other event types.
 */
export function extractLiveOrderForLedger(
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

  // Only process order.live.v1 events
  if (parsed['event_name'] !== 'order.live.v1') return null;

  const props = (parsed['properties'] as Record<string, unknown>) ?? {};

  const orderId = typeof props['order_id'] === 'string' ? props['order_id'] : null;
  const amountMinor = typeof props['amount_minor'] === 'string' ? props['amount_minor'] : null;
  const currencyCode = typeof props['currency_code'] === 'string' ? props['currency_code'] : null;
  const occurredAt = typeof parsed['occurred_at'] === 'string' ? parsed['occurred_at'] : null;
  const paymentMethod =
    typeof props['payment_method'] === 'string' &&
    (props['payment_method'] === 'cod' || props['payment_method'] === 'prepaid')
      ? (props['payment_method'] as 'cod' | 'prepaid')
      : 'prepaid';

  if (!orderId || !amountMinor || !currencyCode || !occurredAt) return null;

  // Validate amount_minor is a non-negative integer string (I-S07)
  if (!/^\d+$/.test(amountMinor)) {
    log.warn(`invalid amount_minor "${amountMinor}" — skipping ledger write`);
    return null;
  }

  return {
    brandId,
    orderId,
    brainId: null,
    amountMinor,
    currencyCode,
    occurredAt,
    paymentMethod,
    sourcePk: eventId,
    rawEventId: eventId,
  };
}

/**
 * Route a live order to the appropriate ledger write path (D-13 / ADR-LV-11).
 *
 * If cancelled_at != null → writeReversal (new negative row, sale untouched).
 * If cancelled_at == null → writeProvisionalRecognition (same as backfill path).
 *
 * @returns 'reversal' | 'provisional' | 'skipped'
 */
export async function routeLiveOrderToLedger(
  rawValue: Buffer | null,
  brandId: string | undefined,
  eventId: string | undefined,
  ledgerWriter: LedgerWriter,
): Promise<'reversal' | 'provisional' | 'skipped'> {
  const ledgerOrder = extractLiveOrderForLedger(rawValue, brandId, eventId);
  if (!ledgerOrder) return 'skipped';

  // Determine if this is a cancellation/RTO event
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawValue!.toString('utf8')) as Record<string, unknown>;
  } catch {
    return 'skipped';
  }

  const props = (parsed['properties'] as Record<string, unknown>) ?? {};
  const cancelledAt = props['cancelled_at'];
  const isCancelled = typeof cancelledAt === 'string' && cancelledAt.length > 0;

  if (isCancelled) {
    // RTO / cancellation — write negative reversal row (D-13 / ADR-LV-11)
    // Sale/provisional/finalized rows are UNTOUCHED (append-only by GRANT)
    await ledgerWriter.writeReversal(ledgerOrder, 'rto_reversal');
    return 'reversal';
  } else {
    // New or updated order without cancellation → provisional recognition
    await ledgerWriter.writeProvisionalRecognition(ledgerOrder);
    return 'provisional';
  }
}
