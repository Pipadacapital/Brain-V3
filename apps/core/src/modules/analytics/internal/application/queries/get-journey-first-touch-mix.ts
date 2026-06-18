/**
 * getJourneyFirstTouchMix — analytics use-case (ADR-002 sole-read-path, Silver tier).
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeFirstTouchMix (metric engine), a read from the Silver
 * mart silver.touchpoint (StarRocks brain_silver) through the withSilverBrand seam. NO
 * ad-hoc COUNT/share here (D-3 / ADR-002) — the metric-engine seam owns the non-additive
 * aggregation (ADR-004: it does NOT live in dbt).
 *
 * Serializes bigint → string (D-1), echoes the [from,to] range, shapes the honest no_data
 * discriminant. NO money column (touchpoints are not monetary).
 *
 * DEV-HONESTY: data_source is supplied by the caller (BFF) — 'synthetic' when the window
 * includes clearly-labelled synthetic journey fixtures, 'live' for real SDK events.
 *
 * I-ST01: the metric-engine is the SOLE Silver reader; the UI reaches Silver only through
 * BFF → this use-case → withSilverBrand. brandId is from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/journey-mix.ts
 * @see packages/metric-engine/src/silver-deps.ts (the Silver read seam)
 */

import type { SilverPool, JourneyChannel } from '@brain/metric-engine';
import { computeFirstTouchMix } from '@brain/metric-engine';

export interface FirstTouchMixRowDto {
  channel: JourneyChannel;
  count: string;            // bigint → string
  share_pct: string | null; // 2dp string; null when total = 0
}

export type JourneyFirstTouchMixResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;            // YYYY-MM-DD (echoed range)
      to: string;              // YYYY-MM-DD
      total: string;           // bigint → string
      by_channel: FirstTouchMixRowDto[];
      data_source: 'synthetic' | 'live';
    };

export interface JourneyFirstTouchMixParams {
  /** Inclusive window on occurred_at. */
  from: Date;
  to: Date;
  /** Echoed back to the client as YYYY-MM-DD (the canonical day strings the BFF parsed). */
  fromStr: string;
  toStr: string;
  /** Source-honesty flag for the Synthetic (dev) badge — supplied by the BFF. */
  dataSource: 'synthetic' | 'live';
}

/**
 * getJourneyFirstTouchMix — a brand's first-touch channel mix over a window.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The StarRocks Silver pool (mysql2, brain_analytics).
 * @param params  - The window + echoed date strings + data_source flag.
 */
export async function getJourneyFirstTouchMix(
  brandId: string,
  deps: { srPool: SilverPool },
  params: JourneyFirstTouchMixParams,
): Promise<JourneyFirstTouchMixResult> {
  const result = await computeFirstTouchMix(brandId, deps, { from: params.from, to: params.to });

  if (!result.hasData) {
    return { state: 'no_data' };
  }

  const by_channel: FirstTouchMixRowDto[] = result.byChannel.map((b) => ({
    channel: b.channel,
    count: String(b.count),
    share_pct: b.sharePct,
  }));

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    total: String(result.total),
    by_channel,
    data_source: params.dataSource,
  };
}
