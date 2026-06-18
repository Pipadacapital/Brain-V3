/**
 * getMetricTrust — the single trust read the analytics read-path + recommendation surfaces
 * consult before showing a metric or shipping a high-risk recommendation (Phase 7, Track B).
 *
 * Returns the effective_confidence grade + trust tier + the full gate decision for the brand,
 * computed deterministically over the LATEST dq_check_result grades + attribution_confidence
 * (the same sole metric-engine read path as getDataQualitySummary). When the brand has no DQ
 * data yet, the honest floor is effective_confidence='D' / tier='untrusted' — which BLOCKS
 * high-risk recommendations (fail-closed: no trust proof → no high-risk rec).
 *
 * @see 02-architecture.md §2c (Phase 7)
 */

import type { EngineDeps, DqLetterGrade, GateDecision, TrustTier } from '@brain/metric-engine';
import { evaluateGate } from '@brain/metric-engine';
import { getDataQualitySummary } from './get-data-quality-summary.js';

export interface MetricTrustResult {
  effectiveConfidence: DqLetterGrade;
  tier: TrustTier;
  gate: GateDecision;
}

/**
 * getMetricTrust — resolve the brand's effective_confidence + gate decision.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getMetricTrust(brandId: string, deps: EngineDeps): Promise<MetricTrustResult> {
  const summary = await getDataQualitySummary(brandId, deps);
  if (summary.state === 'no_data') {
    // Fail-closed: no DQ proof → lowest confidence → blocks high-risk recommendations.
    const gate = evaluateGate('D');
    return { effectiveConfidence: 'D', tier: gate.tier, gate };
  }
  return {
    effectiveConfidence: summary.effectiveConfidence,
    tier: summary.tier,
    gate: summary.gate,
  };
}
