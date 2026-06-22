/**
 * getEngagement — analytics use-case (ADR-002 sole-read-path, Silver tier).
 *
 * @effort deterministic
 *
 * Thin wrapper around computeStorefrontEngagement (metric engine) — a read from silver_touchpoint via
 * the withSilverBrand seam. NO ad-hoc COUNT here (D-3). Serializes bigint → string (D-1), echoes the
 * range, shapes the honest no_data discriminant.
 *
 * I-ST01: metric-engine is the SOLE Silver reader; the UI reaches Silver only through BFF → this
 * use-case → withSilverBrand. brandId is from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/storefront-engagement.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeStorefrontEngagement } from '@brain/metric-engine';

export type EngagementResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;
      to: string;
      sessions: string;
      touches: string;
      engaged_sessions: string;
      bounce_sessions: string;
      engagement_rate_pct: string | null;
      bounce_rate_pct: string | null;
      avg_touches_per_session: string | null;
      data_source: 'synthetic' | 'live';
    };

export interface EngagementParams {
  from: Date;
  to: Date;
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

export async function getEngagement(
  brandId: string,
  deps: { srPool: SilverPool },
  params: EngagementParams,
): Promise<EngagementResult> {
  const r = await computeStorefrontEngagement(brandId, deps, { from: params.from, to: params.to });

  if (!r.hasData) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    sessions: String(r.sessions),
    touches: String(r.touches),
    engaged_sessions: String(r.engagedSessions),
    bounce_sessions: String(r.bounceSessions),
    engagement_rate_pct: r.engagementRatePct,
    bounce_rate_pct: r.bounceRatePct,
    avg_touches_per_session: r.avgTouchesPerSession,
    data_source: params.dataSource,
  };
}
