/**
 * getJourneyTimeline — analytics use-case (ADR-002 sole-read-path, Silver tier).
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeTouchpointTimeline (metric engine), reading the ordered
 * touch rows for ONE journey from silver.touchpoint through the withSilverBrand seam. The
 * journey is resolved by order_id (via the deterministic connector_journey_stitch_map —
 * read-back, D-5) OR directly by brain_anon_id. A read projection (no aggregation), still
 * brand-scoped at the seam (I-ST01). NO money column.
 *
 * Honest no_data when the journey resolves to zero touches. brandId from session (D-1).
 *
 * @see packages/metric-engine/src/journey-mix.ts
 */

import type { SilverPool, JourneyChannel, TimelineSelector } from '@brain/metric-engine';
import { computeTouchpointTimeline } from '@brain/metric-engine';

export interface TimelineTouchDto {
  touch_seq: number;
  is_first_touch: boolean;
  is_last_touch: boolean;
  occurred_at: string;
  channel: JourneyChannel;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  fbclid: string | null;
  gclid: string | null;
  ttclid: string | null;
  referrer_host: string | null;
  landing_path: string | null;
  event_type: string;
}

export type JourneyTimelineResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      brain_anon_id: string;
      stitched: boolean;
      touches: TimelineTouchDto[];
      data_source: 'synthetic' | 'live';
    };

export interface JourneyTimelineParams {
  /** Resolve by order (stitch-map read-back) or directly by anon. */
  selector: TimelineSelector;
  dataSource: 'synthetic' | 'live';
}

/**
 * getJourneyTimeline — the ordered touchpoint timeline for one journey.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The StarRocks Silver pool (mysql2, brain_analytics).
 * @param params  - The selector (orderId | brainAnonId) + data_source flag.
 */
export async function getJourneyTimeline(
  brandId: string,
  deps: { srPool: SilverPool },
  params: JourneyTimelineParams,
): Promise<JourneyTimelineResult> {
  const result = await computeTouchpointTimeline(brandId, deps, params.selector);

  if (!result.hasData || result.brainAnonId === null) {
    return { state: 'no_data' };
  }

  const touches: TimelineTouchDto[] = result.touches.map((t) => ({
    touch_seq: t.touchSeq,
    is_first_touch: t.isFirstTouch,
    is_last_touch: t.isLastTouch,
    occurred_at: t.occurredAt,
    channel: t.channel,
    utm_source: t.utmSource,
    utm_medium: t.utmMedium,
    utm_campaign: t.utmCampaign,
    utm_term: t.utmTerm,
    utm_content: t.utmContent,
    fbclid: t.fbclid,
    gclid: t.gclid,
    ttclid: t.ttclid,
    referrer_host: t.referrerHost,
    landing_path: t.landingPath,
    event_type: t.eventType,
  }));

  return {
    state: 'has_data',
    brain_anon_id: result.brainAnonId,
    stitched: result.stitched,
    touches,
    data_source: params.dataSource,
  };
}
