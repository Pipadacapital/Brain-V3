// SPEC: B.4
/**
 * getJourneyReplay — SPEC: B.4 — Journey Replay (?as_of=) + Explainability.
 *
 * @effort deterministic
 *
 * Reconstructs ONE resolved customer's journey AS KNOWN AT a wall-clock `as_of` — the batch-only
 * replay/audit surface behind GET /api/v1/analytics/journey/events?as_of=<iso> (AMD-14: extend the
 * live BFF journey route; the spec's GET /v1/customers/{brain_id}/journey?as_of= maps here).
 *
 * AMD-10 (BINDING, R1): the reconstruction uses RETAINED journey_events version history +
 * bi-temporal identity intervals — NEVER Iceberg time-travel (SNAPSHOT_TTL_MS=7d makes
 * `FOR TIMESTAMP AS OF` unusable as the system axis). Concretely:
 *   • the journey = the canonical current ledger for brain_id, gated to `occurred_at <= as_of`
 *     (computeJourneyEventsAsOf) — so a pre-identification as_of returns the SHORTER anonymous-era
 *     journey (acceptance B.5.3);
 *   • the identity axis = the map state as the system knew it at as_of (resolveIdentityAsOf over the
 *     sanctioned identity_asof accessor, WA-14) — identity_evidence [{identifier_type, first_seen,
 *     source}] + an `identified` flag (empty ⇒ still anonymous then).
 *
 * Batch-path only — the route NEVER caches this read; the response is always marked `replayed: true`.
 * Every journey item carries matched_via + brain_id_asof (what identity was known then). Brand from
 * session (D-1). MONEY (I-S07): revenue_minor bigint minor-units-string + sibling currency_code.
 *
 * @see packages/metric-engine/src/journey-events.ts (computeJourneyEventsAsOf / resolveIdentityAsOf)
 * @see get-journey-events.ts (the current-projection sibling — no as_of)
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeJourneyEventsAsOf, resolveIdentityAsOf } from '@brain/metric-engine';
import type { JourneyEventDto } from './get-journey-events.js';

export interface IdentityEvidenceDto {
  identifier_type: string;
  first_seen: string;
  source: string;
}

export interface IdentityAsOfStateDto {
  identified: boolean;
  evidence: IdentityEvidenceDto[];
}

export type JourneyReplayResult =
  | { state: 'no_data'; replayed: true; as_of: string }
  | {
      state: 'has_data';
      replayed: true;
      as_of: string;
      brain_id: string;
      events: JourneyEventDto[];
      identity_asof: IdentityAsOfStateDto;
      /** Opaque keyset cursor for the next (older) page; null = last page. */
      next_cursor: string | null;
      data_source: 'synthetic' | 'live';
    };

export interface JourneyReplayQueryParams {
  /** The resolved customer's brain_id (from the Customer 360 surface). */
  brainId: string;
  /** Replay wall-clock — ISO-8601 instant. Only events with occurred_at <= as_of are returned. */
  asOf: string;
  /** Opaque cursor from a previous page's next_cursor. Invalid → first page (never a hard-fail). */
  cursor?: string | null;
  /** Page size (server-clamped; default 50). */
  limit?: number;
  dataSource: 'synthetic' | 'live';
}

// ── Opaque keyset cursor (identical idiom to get-journey-events) ───────────────────────────────────
// base64url-encoded JSON {v, sn}; sn is the last row's sequence_number (bigint digits string). An
// invalid/foreign cursor decodes to null → first page (a read never hard-fails).
interface JourneyReplayCursor {
  v: 1;
  sn: string;
}

function encodeCursor(sequenceNumber: string): string {
  const payload: JourneyReplayCursor = { v: 1, sn: sequenceNumber };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): JourneyReplayCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as JourneyReplayCursor).v === 1 &&
      typeof (parsed as JourneyReplayCursor).sn === 'string' &&
      /^\d+$/.test((parsed as JourneyReplayCursor).sn)
    ) {
      return parsed as JourneyReplayCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * getJourneyReplay — one customer's journey as known at `asOf`, newest-first, + identity_asof state.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - the Trino serving pool (srPool).
 * @param params  - brainId + asOf + optional opaque cursor + page size + data_source flag.
 */
export async function getJourneyReplay(
  brandId: string,
  deps: { srPool: SilverPool },
  params: JourneyReplayQueryParams,
): Promise<JourneyReplayResult> {
  const decoded = params.cursor ? decodeCursor(params.cursor) : null;

  const page = await computeJourneyEventsAsOf(brandId, deps, {
    brainId: params.brainId,
    asOf: params.asOf,
    afterSequence: decoded?.sn ?? null,
    limit: params.limit,
  });

  if (!page.hasData) {
    return { state: 'no_data', replayed: true, as_of: params.asOf };
  }

  // Identity axis: what the system knew about this brain_id's identifiers at as_of (batch, uncached).
  const identityAsOf = await resolveIdentityAsOf(brandId, deps, {
    brainId: params.brainId,
    asOf: params.asOf,
  });

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
    matched_via: e.matchedVia,
    brain_id_asof: e.brainIdAsof,
    estimated: e.estimated,
  }));

  return {
    state: 'has_data',
    replayed: true,
    as_of: params.asOf,
    brain_id: params.brainId,
    events,
    identity_asof: {
      identified: identityAsOf.identified,
      evidence: identityAsOf.evidence.map((i) => ({
        identifier_type: i.identifierType,
        first_seen: i.firstSeen,
        source: i.source,
      })),
    },
    next_cursor: page.nextAfterSequence === null ? null : encodeCursor(page.nextAfterSequence),
    data_source: params.dataSource,
  };
}
