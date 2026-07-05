/**
 * getJourneyEvents — analytics use-case (ADR-002 sole-read-path, versioned journey ledger).
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeJourneyEventsCurrent (metric engine), reading ONE resolved
 * customer's CURRENT journey-ledger page from brain_serving.mv_journey_events_current
 * (is_current = true over iceberg.brain_gold.journey_events) through the withSilverBrand seam.
 * The customer is identified by brain_id (the RESOLVED identity — the same key Customer 360
 * uses), NOT brain_anon_id: an identity merge re-versions the ledger onto the canonical
 * brain_id, so this read always shows the post-merge canonical timeline. Newest-first,
 * keyset-paginated on the ledger sequence (opaque base64url cursor, list-customers idiom):
 * an invalid/foreign cursor decodes to null and the read degrades to the first page — a read
 * projection must never hard-fail on a cursor.
 *
 * MONEY (I-S07): revenue_minor is bigint minor units as a string with sibling currency_code;
 * non-null ONLY on composite transaction rows (revenue truth is the connector order).
 *
 * Honest no_data when the customer has no ledger rows. brandId from session (D-1).
 *
 * @see packages/metric-engine/src/journey-events.ts
 * @see get-journey-timeline.ts (the per-order Silver-touchpoint sibling)
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeJourneyEventsCurrent } from '@brain/metric-engine';

export interface JourneyEventDto {
  touchpoint_id: string;
  /** bigint → string (ledger position — NOT money). */
  sequence_number: string;
  occurred_at: string;
  event_category: string | null;
  event_type: string;
  channel: string | null;
  campaign: string | null;
  /** bigint minor units as string (I-S07); non-null ONLY on composite rows. */
  revenue_minor: string | null;
  currency_code: string | null;
  is_composite: boolean;
  /** 0..1 double — NOT money. */
  identity_confidence: number | null;
  data_version: number;
}

export type JourneyEventsResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      brain_id: string;
      events: JourneyEventDto[];
      /** Opaque keyset cursor for the next (older) page; null = last page. */
      next_cursor: string | null;
      data_source: 'synthetic' | 'live';
    };

export interface JourneyEventsQueryParams {
  /** The resolved customer's brain_id (from the Customer 360 surface). */
  brainId: string;
  /** Opaque cursor from a previous page's next_cursor. Invalid → first page (never a hard-fail). */
  cursor?: string | null;
  /** Page size (server-clamped; default 50). */
  limit?: number;
  dataSource: 'synthetic' | 'live';
}

// ── Opaque keyset cursor (list-customers idiom) ────────────────────────────────
// The cursor is a POSITION, not a secret: base64url-encoded JSON {v, sn}. sn is the last row's
// sequence_number (bigint carried as digits string — BigInt-safe). Encoding keeps it opaque and
// URL-safe; an invalid/foreign cursor decodes to null → first page (a read never hard-fails).

interface JourneyEventsCursor {
  v: 1;
  /** Last row's sequence_number (digits string; the strict `<` keyset bound). */
  sn: string;
}

function encodeJourneyEventsCursor(sequenceNumber: string): string {
  const payload: JourneyEventsCursor = { v: 1, sn: sequenceNumber };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeJourneyEventsCursor(cursor: string): JourneyEventsCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as JourneyEventsCursor).v === 1 &&
      typeof (parsed as JourneyEventsCursor).sn === 'string' &&
      /^\d+$/.test((parsed as JourneyEventsCursor).sn)
    ) {
      return parsed as JourneyEventsCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * getJourneyEvents — one customer's current journey-ledger page, newest-first.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Trino serving pool (srPool).
 * @param params  - brainId + optional opaque cursor + page size + data_source flag.
 */
export async function getJourneyEvents(
  brandId: string,
  deps: { srPool: SilverPool },
  params: JourneyEventsQueryParams,
): Promise<JourneyEventsResult> {
  const decoded = params.cursor ? decodeJourneyEventsCursor(params.cursor) : null;

  const page = await computeJourneyEventsCurrent(brandId, deps, {
    brainId: params.brainId,
    afterSequence: decoded?.sn ?? null,
    limit: params.limit,
  });

  if (!page.hasData) {
    return { state: 'no_data' };
  }

  const events: JourneyEventDto[] = page.events.map((e) => ({
    touchpoint_id: e.touchpointId,
    sequence_number: e.sequenceNumber,
    occurred_at: e.occurredAt,
    event_category: e.eventCategory,
    event_type: e.eventType,
    channel: e.channel,
    campaign: e.campaign,
    revenue_minor: e.revenueMinor,
    currency_code: e.currencyCode,
    is_composite: e.isComposite,
    identity_confidence: e.identityConfidence,
    data_version: e.dataVersion,
  }));

  return {
    state: 'has_data',
    brain_id: params.brainId,
    events,
    next_cursor: page.nextAfterSequence === null ? null : encodeJourneyEventsCursor(page.nextAfterSequence),
    data_source: params.dataSource,
  };
}
