/**
 * getRtoRiskDistribution — analytics use-case (ADR-002 sole-read-path).
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeRtoRiskDistribution (metric engine) over the
 * gokwik.rto_predict.v1 Bronze stream. NO ad-hoc COUNT (D-3). Serializes bigint → string (D-1)
 * and shapes the honest no_data discriminant. The risk_flag buckets are VERBATIM categorical
 * (never a fabricated score). data_source reflects the actual payload stamp (synthetic in dev —
 * GoKwik's read API is undocumented; real shape, synthetic source).
 *
 * RLS / F-SEC-02: engine reads inside withBrandTxn. Brand from session (D-1).
 *
 * @see packages/metric-engine/src/cod-rto-prediction.ts
 */
import type { EngineDeps } from '@brain/metric-engine';
import { computeRtoRiskDistribution } from '@brain/metric-engine';

export type RtoRiskDistributionResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      order_count: string; // bigint → string (distinct orders, counted by latest prediction)
      high: string;
      medium: string;
      low: string;
      control: string;
      unknown: string;
      data_source: 'synthetic' | 'live';
    };

export async function getRtoRiskDistribution(
  brandId: string,
  deps: EngineDeps,
): Promise<RtoRiskDistributionResult> {
  const r = await computeRtoRiskDistribution(brandId, deps);
  if (!r.hasData) return { state: 'no_data' };
  return {
    state: 'has_data',
    order_count: String(r.orderCount),
    high: String(r.high),
    medium: String(r.medium),
    low: String(r.low),
    control: String(r.control),
    unknown: String(r.unknown),
    data_source: r.dataSource,
  };
}
