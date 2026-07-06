/**
 * getJourneyList — analytics use-case (ADR-002 sole-read-path) for the recent-journeys list.
 *
 * Paginated per-journey list over the serving view mv_gold_journey (one row per
 * (brand_id, brain_anon_id)), via computeJourneyList (metric engine) through the withSilverBrand
 * seam (I-ST01 — the engine is the sole serving reader; the UI never queries the lakehouse). Newest-
 * first by last_touch_at, keyset-paginated (opaque next_cursor). NO ad-hoc SQL here (D-3 / ADR-002);
 * the engine owns the projection + keyset. NO MONEY (a journey list is behavioral).
 *
 * Serializes bigint → string (D-1), shapes the honest no_data discriminant, echoes the data_source
 * source-honesty flag the BFF supplies. brandId from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/journey-list.ts
 */

import type { SilverPool, JourneyChannel } from '@brain/metric-engine';
import { computeJourneyList } from '@brain/metric-engine';

export interface JourneyListRowDto {
  brain_anon_id: string;
  first_touch_at: string;
  last_touch_at: string;
  first_channel: JourneyChannel;
  last_channel: JourneyChannel;
  touchpoint_count: string; // bigint → string
  distinct_channels: string; // bigint → string
  distinct_sessions: string; // bigint → string
  converted: boolean;
  converted_at: string | null;
  days_to_convert: string | null; // bigint → string; null when not converted
}

export type JourneyListResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      total: string; // bigint → string (brand-wide journey count)
      rows: JourneyListRowDto[];
      next_cursor: string | null; // opaque keyset cursor; null = last page
      data_source: 'synthetic' | 'live';
    };

export interface JourneyListParams {
  /** Source-honesty flag for the Synthetic (dev) badge — supplied by the BFF. */
  dataSource: 'synthetic' | 'live';
  /** Page size (default 25; the engine clamps 1..100). */
  limit?: number;
  /** Opaque keyset continuation from a prior page's next_cursor (invalid → first page). */
  cursor?: string | null;
}

/**
 * getJourneyList — a brand's recent customer journeys, newest-first, keyset-paginated.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Trino serving pool (mv_gold_journey).
 * @param params  - data_source flag + optional limit + opaque cursor.
 */
export async function getJourneyList(
  brandId: string,
  deps: { srPool: SilverPool },
  params: JourneyListParams,
): Promise<JourneyListResult> {
  const result = await computeJourneyList(brandId, deps, {
    limit: params.limit,
    cursor: params.cursor ?? null,
  });

  if (!result.hasData) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    total: String(result.total),
    rows: result.rows.map((r) => ({
      brain_anon_id: r.brainAnonId,
      first_touch_at: r.firstTouchAt,
      last_touch_at: r.lastTouchAt,
      first_channel: r.firstChannel,
      last_channel: r.lastChannel,
      touchpoint_count: String(r.touchpointCount),
      distinct_channels: String(r.distinctChannels),
      distinct_sessions: String(r.distinctSessions),
      converted: r.converted,
      converted_at: r.convertedAt,
      days_to_convert: r.daysToConvert == null ? null : String(r.daysToConvert),
    })),
    next_cursor: result.nextCursor,
    data_source: params.dataSource,
  };
}
