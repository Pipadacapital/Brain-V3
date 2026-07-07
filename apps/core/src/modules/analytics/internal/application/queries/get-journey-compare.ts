// SPEC: B.3
/**
 * getJourneyCompare — the B.3 two-journey compare surface (AMD-14).
 *
 * `GET /v1/journeys/compare?left=&right=` — two resolved-customer journeys side by side, each
 * touch annotated with t_minus_conversion_ms (ms from that touch to the journey's conversion).
 * Both journeys are read from the durable versioned ledger (mv_journey_events_current) keyed by
 * brain_id — the same canonical key the per-customer timeline uses. The conversion anchor is the
 * LATEST composite (order) touch in each journey; t_minus is anchor − touch (positive BEFORE the
 * conversion, 0 at it). A journey that never converted has conversion_at = null and every
 * t_minus_conversion_ms = null (honest — we do not fabricate a conversion anchor).
 *
 * brand_id is from the SESSION (D-1); both brain_ids are lookup keys WITHIN the brand (the ledger
 * read is brand-scoped at the seam). Money is untouched here (compare is behavioral timing) — the
 * ledger's revenue_minor is not surfaced on this shape.
 *
 * @see packages/metric-engine/src/journey-events.ts (computeJourneyEventsCurrent)
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeJourneyEventsCurrent } from '@brain/metric-engine';
import type { JourneyCompare, CompareJourney, CompareTouch } from '@brain/contracts';

/** Max touches read per side (the ledger page cap). */
const COMPARE_MAX_TOUCHES = 200;

export interface JourneyCompareParams {
  left: string;
  right: string;
  dataSource: 'synthetic' | 'live';
}

/** Parse a Trino/Iceberg timestamp string ('YYYY-MM-DD HH:MM:SS[.fff] UTC') → epoch ms, or null. */
function parseServingTsMs(s: string): number | null {
  const iso = s.trim().replace(/\s+UTC$/i, 'Z').replace(' ', 'T');
  const ms = Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Build one side of the compare: the ledger events for a brain_id + per-touch t_minus_conversion. */
async function buildSide(
  brandId: string,
  deps: { srPool: SilverPool },
  brainId: string,
): Promise<CompareJourney> {
  const page = await computeJourneyEventsCurrent(brandId, deps, { brainId, limit: COMPARE_MAX_TOUCHES });
  if (!page.hasData) {
    return { brain_id: brainId, conversion_at: null, touches: [] };
  }

  // Conversion anchor = the LATEST composite (order) touch; null when the journey never converted.
  let anchorMs: number | null = null;
  let anchorAt: string | null = null;
  for (const e of page.events) {
    if (!e.isComposite) continue;
    const ms = parseServingTsMs(e.occurredAt);
    if (ms !== null && (anchorMs === null || ms > anchorMs)) {
      anchorMs = ms;
      anchorAt = e.occurredAt;
    }
  }

  // The ledger page is newest-first; present the compare chronologically (oldest → newest).
  const chronological = [...page.events].reverse();
  const touches: CompareTouch[] = chronological.map((e) => {
    const ms = parseServingTsMs(e.occurredAt);
    const tMinus = anchorMs !== null && ms !== null ? anchorMs - ms : null;
    return {
      sequence_number: e.sequenceNumber,
      occurred_at: e.occurredAt,
      event_type: e.eventType,
      channel: e.channel,
      campaign: e.campaign,
      is_composite: e.isComposite,
      t_minus_conversion_ms: tMinus,
    };
  });

  return { brain_id: brainId, conversion_at: anchorAt, touches };
}

/**
 * getJourneyCompare — two resolved journeys with per-touch time-to-conversion.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - the Trino serving pool (srPool).
 * @param params  - left + right brain_ids + data_source flag.
 */
export async function getJourneyCompare(
  brandId: string,
  deps: { srPool: SilverPool },
  params: JourneyCompareParams,
): Promise<JourneyCompare> {
  const [left, right] = await Promise.all([
    buildSide(brandId, deps, params.left),
    buildSide(brandId, deps, params.right),
  ]);
  return { left, right, data_source: params.dataSource };
}
