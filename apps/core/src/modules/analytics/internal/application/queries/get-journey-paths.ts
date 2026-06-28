/**
 * getJourneyPaths — analytics use-case (ADR-002 sole-read-path) for the #32a journey Sankey.
 *
 * Aggregate journey-path flow over the Gold mart gold_journey_paths, via computeJourneyPaths
 * (metric engine) through the withSilverBrand seam (I-ST01 — the engine is the sole Gold reader;
 * the UI never queries the lakehouse directly). Returns the top-N ordered channel PATHS (each with
 * its journey + conversion counts and the drop-off) plus the aggregated Sankey EDGES the path-flow
 * draws. NO ad-hoc arithmetic (D-3); the engine derives every ratio. NO MONEY (paths are behavioral).
 *
 * Serializes bigint → string (D-1), shapes the honest no_data discriminant, echoes the data_source
 * source-honesty flag the BFF supplies. brandId from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/journey-paths.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeJourneyPaths } from '@brain/metric-engine';

export interface JourneyPathRowDto {
  path_signature: string;
  path_length: number;
  channels: string[];
  first_touch_channel: string;
  last_touch_channel: string;
  journey_count: string; // bigint → string
  converted_count: string; // bigint → string
  dropped_count: string; // bigint → string
  conversion_pct: string | null; // 2dp string; null when journey_count = 0
  path_rank: number;
}

export interface JourneyPathLinkDto {
  step: number;
  from_channel: string;
  to_channel: string;
  journeys: string; // bigint → string
}

export type JourneyPathsResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      total_paths: number;
      total_journeys: string; // bigint → string
      total_converted: string; // bigint → string
      overall_conversion_pct: string | null;
      paths: JourneyPathRowDto[];
      links: JourneyPathLinkDto[];
      data_source: 'synthetic' | 'live';
    };

export interface JourneyPathsParams {
  /** Source-honesty flag for the Synthetic (dev) badge — supplied by the BFF. */
  dataSource: 'synthetic' | 'live';
  /** Max top paths to return (default 25; the engine clamps 1..50). */
  limit?: number;
}

/**
 * getJourneyPaths — a brand's top channel paths + Sankey edges + headline.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Trino Gold serving pool (mv_gold_journey_paths).
 * @param params  - data_source flag + optional top-N limit.
 */
export async function getJourneyPaths(
  brandId: string,
  deps: { srPool: SilverPool },
  params: JourneyPathsParams,
): Promise<JourneyPathsResult> {
  const result = await computeJourneyPaths(brandId, deps, { limit: params.limit });

  if (!result.hasData) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    total_paths: result.totalPaths,
    total_journeys: String(result.totalJourneys),
    total_converted: String(result.totalConverted),
    overall_conversion_pct: result.overallConversionPct,
    paths: result.paths.map((p) => ({
      path_signature: p.pathSignature,
      path_length: p.pathLength,
      channels: p.channels,
      first_touch_channel: p.firstTouchChannel,
      last_touch_channel: p.lastTouchChannel,
      journey_count: String(p.journeyCount),
      converted_count: String(p.convertedCount),
      dropped_count: String(p.droppedCount),
      conversion_pct: p.conversionPct,
      path_rank: p.pathRank,
    })),
    links: result.links.map((l) => ({
      step: l.step,
      from_channel: l.fromChannel,
      to_channel: l.toChannel,
      journeys: String(l.journeys),
    })),
    data_source: params.dataSource,
  };
}
