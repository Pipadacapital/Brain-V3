/**
 * @brain/metric-engine — computeJourneyEventsCurrent (versioned journey-ledger serving read).
 *
 * The SOLE read seam for the versioned event-sourced journey ledger's CURRENT projection
 * (brain_serving.mv_journey_events_current — `is_current = true` over iceberg.brain_gold.journey_events,
 * built by gold_journey_events.py + its merge re-versioning companion). One row per
 * (brand_id, touchpoint_id): the canonical resolved-identity timeline for a customer — an identity
 * merge flips the superseded version and appends a data_version+1 copy owned by the canonical
 * brain_id, so this read always shows the post-merge truth without rewriting history.
 *
 * Read through withSilverBrand (brand predicate injected at the seam, I-ST01; the engine is the only
 * serving reader — the UI never queries Trino). Newest-first, KEYSET-paginated:
 * sequence_number is assigned by `row_number() OVER (PARTITION BY brand_id, brain_id ORDER BY
 * occurred_at ASC, touch_seq ASC)` at build time, so within ONE brain_id `ORDER BY occurred_at DESC,
 * sequence_number DESC` is exactly `ORDER BY sequence_number DESC` — the keyset continuation is the
 * single strict `sequence_number < ?` bound (bigint-exact; no timestamp-precision drift in the cursor).
 *
 * MONEY (I-S07): revenueMinor is bigint MINOR units carried as a string (BigInt-safe JSON) with the
 * sibling currencyCode — never a float, never blended; non-null ONLY on composite transaction rows
 * (revenue truth is the connector order, joined from silver_order_state at build time).
 *
 * Honest-empty: hasData=false when the customer has no ledger rows (or the serving tier is
 * unavailable — the seam degrades a missing mart to []). NO PII: brain_id is the opaque resolved key.
 *
 * @see db/trino/views/mv_journey_events_current.sql (the served projection)
 * @see packages/metric-engine/src/customer-orders.ts (sibling per-customer serving read)
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface JourneyEventRow {
  /** Stable ledger key of this journey event (one current version each). */
  touchpointId: string;
  /** Resolved-timeline position (bigint → string, BigInt-safe JSON); the keyset cursor key. */
  sequenceNumber: string;
  /** Raw Trino/Iceberg timestamp string (UTC); serialized verbatim. */
  occurredAt: string;
  /** Derived event category (the Silver SoT mapping). Null = uncategorized. */
  eventCategory: string | null;
  eventType: string;
  channel: string | null;
  campaign: string | null;
  /** bigint MINOR units as string (I-S07); non-null ONLY on composite transaction rows. */
  revenueMinor: string | null;
  /** Sibling currency for revenueMinor — never blended. Null when revenueMinor is null. */
  currencyCode: string | null;
  /** True = a composite transaction row (order joined onto the journey). */
  isComposite: boolean;
  /** Identity-resolution confidence (0..1 double) — NOT money, NOT a percentage. Null = unresolved. */
  identityConfidence: number | null;
  /** Ledger version of this row (re-versioned on identity merge; served row is always current). */
  dataVersion: number;
}

export interface JourneyEventsPage {
  /** True iff the customer has any current ledger rows. */
  hasData: boolean;
  /** The page of events (newest-first). */
  events: JourneyEventRow[];
  /**
   * The last row's sequence_number when a FURTHER page exists (pass back as afterSequence);
   * null = this page is the last.
   */
  nextAfterSequence: string | null;
}

export interface JourneyEventsParams {
  /** The resolved customer's brain_id (canonical owner of the current ledger rows). */
  brainId: string;
  /** Keyset continuation: only rows with sequence_number strictly BELOW this (digits string). */
  afterSequence?: string | null;
  /** Page size (clamped 1..200; default 50). */
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Normalize a possibly-null DB string field. */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

/** Normalize a Trino boolean (native boolean, or 0/1 over a legacy wire) → boolean. */
function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1';
}

interface JourneyEventDbRow {
  touchpoint_id: string;
  sequence_number: string | number;
  occurred_at: string;
  event_category: string | null;
  event_type: string;
  channel: string | null;
  campaign: string | null;
  revenue_minor: string | number | null;
  currency_code: string | null;
  is_composite: number | boolean;
  identity_confidence: string | number | null;
  data_version: string | number;
}

/**
 * computeJourneyEventsCurrent — one customer's current journey-ledger page, newest-first.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - the Trino serving pool (createTrinoPool) injected at the root.
 * @param params  - brainId + optional keyset continuation (afterSequence) + page size.
 */
export async function computeJourneyEventsCurrent(
  brandId: string,
  deps: { srPool: SilverPool },
  params: JourneyEventsParams,
): Promise<JourneyEventsPage> {
  if (!params.brainId || params.brainId.length === 0) {
    return { hasData: false, events: [], nextAfterSequence: null };
  }
  const lim = Math.min(Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

  // The keyset bound is seam-validated (digits only) then bound as a bigint param — an invalid
  // continuation is treated as absent (first page) rather than hard-failing a read.
  const after =
    params.afterSequence && /^\d+$/.test(params.afterSequence) ? BigInt(params.afterSequence) : null;

  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally (see journey-mix.ts).
    // LIMIT lim+1 = look-ahead row: its presence means a further page exists (it is not returned).
    if (after !== null) {
      return scope.runScoped<JourneyEventDbRow>(
        `SELECT touchpoint_id, sequence_number, occurred_at, event_category, event_type,
                channel, campaign, revenue_minor, currency_code, is_composite,
                identity_confidence, data_version
           FROM brain_serving.mv_journey_events_current
          WHERE brain_id = ?
            AND sequence_number < ?
            AND ${BRAND_PREDICATE}
          ORDER BY occurred_at DESC, sequence_number DESC
          LIMIT ${lim + 1}`,
        [params.brainId, after],
      );
    }
    return scope.runScoped<JourneyEventDbRow>(
      `SELECT touchpoint_id, sequence_number, occurred_at, event_category, event_type,
              channel, campaign, revenue_minor, currency_code, is_composite,
              identity_confidence, data_version
         FROM brain_serving.mv_journey_events_current
        WHERE brain_id = ?
          AND ${BRAND_PREDICATE}
        ORDER BY occurred_at DESC, sequence_number DESC
        LIMIT ${lim + 1}`,
      [params.brainId],
    );
  });

  if (rows.length === 0) {
    return { hasData: false, events: [], nextAfterSequence: null };
  }

  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;

  const events: JourneyEventRow[] = page.map((r) => ({
    touchpointId: String(r.touchpoint_id),
    // bigint-safe: Trino may surface bigint as string or number — String() either way (never float math).
    sequenceNumber: String(r.sequence_number),
    occurredAt: String(r.occurred_at),
    eventCategory: str(r.event_category),
    eventType: String(r.event_type),
    channel: str(r.channel),
    campaign: str(r.campaign),
    // Money: bigint minor units → string verbatim (drop any decimal tail — exact integer in the mart).
    revenueMinor: r.revenue_minor == null ? null : String(String(r.revenue_minor).split('.')[0] ?? '0'),
    currencyCode: str(r.currency_code),
    isComposite: asBool(r.is_composite),
    identityConfidence:
      r.identity_confidence === null || r.identity_confidence === undefined
        ? null
        : Number(r.identity_confidence),
    dataVersion: Number(r.data_version),
  }));

  const last = events[events.length - 1];
  return {
    hasData: true,
    events,
    nextAfterSequence: hasMore && last ? last.sequenceNumber : null,
  };
}
