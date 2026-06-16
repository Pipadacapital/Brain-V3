/**
 * LedgerEventId — deterministic SHA-256 based ID for ledger rows.
 * sha256(brand_id ‖ order_id ‖ event_type ‖ source_pk ‖ version)
 * Replay-idempotent: same inputs always produce the same ID (D-4).
 * Uses node:crypto — same pattern as identity-core resolution (no new dep).
 */

import { createHash } from 'node:crypto';

const VERSION = 'v1';

/**
 * Compute the deterministic ledger_event_id for a row.
 * The result is a 64-character hex string (SHA-256 output).
 */
export function computeLedgerEventId(params: {
  brandId: string;
  orderId: string;
  eventType: string;
  sourcePk: string;
}): string {
  const { brandId, orderId, eventType, sourcePk } = params;
  return createHash('sha256')
    .update(`${brandId}\0${orderId}\0${eventType}\0${sourcePk}\0${VERSION}`)
    .digest('hex');
}
