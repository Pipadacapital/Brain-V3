/**
 * getBehaviorOverview — analytics use-case (ADR-002 sole-read-path, Silver tier).
 *
 * @effort deterministic
 *
 * Thin wrapper around computeStorefrontBehavior (metric engine) — a read from silver_touchpoint via
 * the withSilverBrand seam. NO ad-hoc COUNT here (D-3); the seam owns the non-additive aggregation.
 * Serializes bigint → string (D-1), echoes the range, shapes the honest no_data discriminant.
 *
 * I-ST01: metric-engine is the SOLE Silver reader; the UI reaches Silver only through BFF → this
 * use-case → withSilverBrand. brandId is from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/storefront-behavior.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeStorefrontBehavior } from '@brain/metric-engine';

export interface PageTypeBucketDto {
  page_type: string;
  count: string;
  share_pct: string | null;
}

export interface BrowsedItemDto {
  key: string;
  count: string;
  reach: string;
}

export type BehaviorOverviewResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;
      to: string;
      sessions: string;
      journeys: string;
      touches: string;
      page_type_mix: PageTypeBucketDto[];
      top_products: BrowsedItemDto[];
      top_searches: BrowsedItemDto[];
      data_source: 'synthetic' | 'live';
    };

export interface BehaviorOverviewParams {
  from: Date;
  to: Date;
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

export async function getBehaviorOverview(
  brandId: string,
  deps: { srPool: SilverPool },
  params: BehaviorOverviewParams,
): Promise<BehaviorOverviewResult> {
  const r = await computeStorefrontBehavior(brandId, deps, { from: params.from, to: params.to });

  if (!r.hasData) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    sessions: String(r.sessions),
    journeys: String(r.journeys),
    touches: String(r.touches),
    page_type_mix: r.pageTypeMix.map((b) => ({ page_type: b.pageType, count: String(b.count), share_pct: b.sharePct })),
    top_products: r.topProducts.map((p) => ({ key: p.key, count: String(p.count), reach: String(p.reach) })),
    top_searches: r.topSearches.map((p) => ({ key: p.key, count: String(p.count), reach: String(p.reach) })),
    data_source: params.dataSource,
  };
}
