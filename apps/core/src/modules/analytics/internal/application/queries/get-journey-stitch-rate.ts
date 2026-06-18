/**
 * getJourneyStitchRate — analytics use-case (ADR-002 sole-read-path, Silver tier).
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeStitchHitRate (metric engine), reading silver.touchpoint
 * through the withSilverBrand seam. The cart-stitch is DETERMINISTIC — stitched_brain_id is
 * read BACK from the order via the connector_journey_stitch_map (NEVER inferred — D-5).
 * NO ad-hoc COUNT here (D-3 / ADR-002); the engine owns the non-additive ratio (ADR-004).
 *
 * Serializes bigint → string (D-1), echoes the [from,to] range, honest no_data on total=0.
 *
 * I-ST01: metric-engine is the SOLE Silver reader. brandId is from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/journey-mix.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeStitchHitRate } from '@brain/metric-engine';

export type JourneyStitchRateResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;            // YYYY-MM-DD (echoed range)
      to: string;              // YYYY-MM-DD
      total: string;           // bigint → string (distinct anon journeys)
      stitched: string;        // bigint → string (distinct stitched journeys)
      hit_pct: string | null;  // 2dp string; null when total = 0
      data_source: 'synthetic' | 'live';
    };

export interface JourneyStitchRateParams {
  from: Date;
  to: Date;
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

/**
 * getJourneyStitchRate — a brand's deterministic cart-stitch hit-rate over a window.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The StarRocks Silver pool (mysql2, brain_analytics).
 * @param params  - The window + echoed date strings + data_source flag.
 */
export async function getJourneyStitchRate(
  brandId: string,
  deps: { srPool: SilverPool },
  params: JourneyStitchRateParams,
): Promise<JourneyStitchRateResult> {
  const result = await computeStitchHitRate(brandId, deps, { from: params.from, to: params.to });

  if (!result.hasData) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    total: String(result.total),
    stitched: String(result.stitched),
    hit_pct: result.hitPct,
    data_source: params.dataSource,
  };
}
