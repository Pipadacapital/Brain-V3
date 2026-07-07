// SPEC: B.3
/**
 * getJourneyTrace — the B.3 per-order explainability surface (AMD-14).
 *
 * `GET /v1/journeys/trace?order_id=` — the ordered touchpoints in the attribution lookback
 * preceding an order, each with its matched_via, PLUS the resolved customer's identity_evidence
 * (why the journey attributes to this person). Resolves order → deterministically-stitched anon
 * journey via the PG stitch map (D-5, read-back), reads the touches from the Trino Silver
 * timeline projection, then trims to the lookback window before the conversion touch.
 *
 * identity_evidence is read over the bi-temporal identity map for the stitched brain_id
 * (identifier_type + first_seen + provenance; hash-only, never a value). matched_via is honestly
 * NULL (blocked on the B.1 stitch-provenance column). brand_id is from the SESSION (D-1), the
 * order_id is a lookup key WITHIN the brand (the stitch read is brand-scoped by RLS).
 *
 * Honest no_data when the order resolves to zero stitched touches.
 *
 * @see packages/metric-engine/src/journey-mix.ts (computeTouchpointTimeline)
 * @see packages/metric-engine/src/journey-identity-evidence.ts (computeIdentityEvidence)
 */

import type { Pool } from 'pg';
import type { SilverPool } from '@brain/metric-engine';
import { computeTouchpointTimeline, computeIdentityEvidence } from '@brain/metric-engine';
import type { JourneyTrace, TraceTouch, IdentityEvidenceItem } from '@brain/contracts';

/** Default attribution lookback (days) applied before the conversion touch. */
export const DEFAULT_TRACE_LOOKBACK_DAYS = 30;

export interface JourneyTraceParams {
  orderId: string;
  /** Attribution lookback window in days (server-clamped 1..365; default 30). */
  lookbackDays?: number;
  dataSource: 'synthetic' | 'live';
}

/** Parse a Trino/Iceberg timestamp string ('YYYY-MM-DD HH:MM:SS[.fff] UTC') → epoch ms, or null. */
function parseServingTsMs(s: string): number | null {
  // Normalize ' UTC' suffix and the space separator to an ISO-8601 Z instant.
  const iso = s.trim().replace(/\s+UTC$/i, 'Z').replace(' ', 'T');
  const ms = Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * getJourneyTrace — the lookback touchpoints + identity evidence for one order.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - the Trino serving pool (srPool) + the PG pool (pool) for the order→anon stitch map.
 * @param params  - orderId + optional lookback window + data_source flag.
 */
export async function getJourneyTrace(
  brandId: string,
  deps: { srPool: SilverPool; pool?: Pool },
  params: JourneyTraceParams,
): Promise<JourneyTrace> {
  const lookbackDays = Math.min(Math.max(1, Math.trunc(params.lookbackDays ?? DEFAULT_TRACE_LOOKBACK_DAYS)), 365);

  const timeline = await computeTouchpointTimeline(brandId, deps, { orderId: params.orderId });
  if (!timeline.hasData || timeline.touches.length === 0) {
    return { state: 'no_data' };
  }

  // Conversion anchor = the latest touch in the resolved journey (the order-adjacent touch).
  const tsList = timeline.touches
    .map((t) => parseServingTsMs(t.occurredAt))
    .filter((v): v is number => v !== null);
  const anchorMs = tsList.length > 0 ? Math.max(...tsList) : null;
  const windowStartMs = anchorMs === null ? null : anchorMs - lookbackDays * 24 * 60 * 60 * 1000;

  const touches: TraceTouch[] = timeline.touches
    .filter((t) => {
      if (windowStartMs === null) return true; // unparseable ts → keep (honest, don't silently drop)
      const ms = parseServingTsMs(t.occurredAt);
      return ms === null || ms >= windowStartMs;
    })
    .map((t) => ({
      touch_seq: t.touchSeq,
      occurred_at: t.occurredAt,
      channel: t.channel,
      event_type: t.eventType,
      utm_campaign: t.utmCampaign,
      landing_path: t.landingPath,
      matched_via: null, // B.1 gap — honest null until stitch-provenance lands
    }));

  // identity_evidence for the resolved customer (best-effort; anon-only → empty).
  let identityEvidence: IdentityEvidenceItem[] = [];
  if (timeline.stitchedBrainId) {
    const ev = await computeIdentityEvidence(brandId, deps, timeline.stitchedBrainId);
    identityEvidence = ev.evidence.map((e) => ({
      identifier_type: e.identifierType,
      first_seen: e.firstSeen,
      source: e.source,
    }));
  }

  return {
    state: 'has_data',
    order_id: params.orderId,
    brain_id: timeline.stitchedBrainId,
    lookback_days: lookbackDays,
    touches,
    identity_evidence: identityEvidence,
    data_source: params.dataSource,
  };
}
