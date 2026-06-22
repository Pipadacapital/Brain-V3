/**
 * getFunnelAnalytics — analytics use-case (ADR-002 sole-read-path, Silver tier).
 *
 * @effort deterministic
 *
 * Thin wrapper around computeStorefrontFunnel (metric engine) — a read from silver_touchpoint via the
 * withSilverBrand seam. NO ad-hoc COUNT here (D-3); the seam owns the non-additive aggregation.
 * Serializes bigint → string (D-1), echoes the range, shapes the honest no_data discriminant.
 *
 * I-ST01: metric-engine is the SOLE Silver reader; the UI reaches Silver only through BFF → this
 * use-case → withSilverBrand. brandId is from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/storefront-funnel.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeStorefrontFunnel } from '@brain/metric-engine';

export interface FunnelStageDto {
  key: string;
  sessions: string;
  conversion_pct: string | null;
  step_pct: string | null;
}

export type FunnelAnalyticsResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;
      to: string;
      stages: FunnelStageDto[];
      data_source: 'synthetic' | 'live';
    };

export interface FunnelAnalyticsParams {
  from: Date;
  to: Date;
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

export async function getFunnelAnalytics(
  brandId: string,
  deps: { srPool: SilverPool },
  params: FunnelAnalyticsParams,
): Promise<FunnelAnalyticsResult> {
  const r = await computeStorefrontFunnel(brandId, deps, { from: params.from, to: params.to });

  if (!r.hasData) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    stages: r.stages.map((s) => ({
      key: s.key,
      sessions: String(s.sessions),
      conversion_pct: s.conversionPct,
      step_pct: s.stepPct,
    })),
    data_source: params.dataSource,
  };
}
