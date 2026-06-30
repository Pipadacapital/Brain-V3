/**
 * getSearchBehavior — analytics use-case (ADR-002 sole-read-path, Gold tier).
 *
 * @effort deterministic
 *
 * Thin wrapper around computeSearchBehavior (metric engine) — a read of the page_type='search' slice
 * of gold_behavior via the withSilverBrand seam. NO ad-hoc COUNT here (D-3); the seam owns the
 * aggregation. Serializes bigint → string (D-1), echoes the range, shapes the honest no_data
 * discriminant. NO MONEY (search is impression counting).
 *
 * I-ST01: metric-engine is the SOLE Gold reader; the UI reaches Gold only through BFF → this
 * use-case → withSilverBrand. brandId is from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/search-behavior.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeSearchBehavior } from '@brain/metric-engine';

export interface SearchDayBucketDto {
  date: string;
  searches: string; // bigint → string
  sessions: string; // bigint → string
  journeys: string; // bigint → string
}

export type SearchBehaviorResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;
      to: string;
      searches: string;
      sessions: string;
      journeys: string;
      days: SearchDayBucketDto[];
      data_source: 'synthetic' | 'live';
    };

export interface SearchBehaviorParams {
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

export async function getSearchBehavior(
  brandId: string,
  deps: { srPool: SilverPool },
  params: SearchBehaviorParams,
): Promise<SearchBehaviorResult> {
  const r = await computeSearchBehavior(brandId, deps, {
    fromStr: params.fromStr,
    toStr: params.toStr,
  });

  if (!r.hasData) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    searches: String(r.searches),
    sessions: String(r.sessions),
    journeys: String(r.journeys),
    days: r.days.map((d) => ({
      date: d.date,
      searches: String(d.searches),
      sessions: String(d.sessions),
      journeys: String(d.journeys),
    })),
    data_source: params.dataSource,
  };
}
