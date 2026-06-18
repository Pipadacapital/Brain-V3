/**
 * @brain/metric-engine — the quality gate (Tier-0 deterministic, frozen).
 *
 * Turns an `effective_confidence` letter grade into the trust-tier decision the
 * analytics read-path and recommendation surfaces consult:
 *
 *   • Trusted   (A+ | A | B) → full recommendations + billing-cap applies + included in MMM.
 *   • Estimated (C)          → degraded/blocked, NO billing cap, EXCLUDED from MMM,
 *                              and BLOCKS high-risk recommendations.
 *   • Untrusted (D)          → same as Estimated (no cap, excluded MMM, blocks high-risk).
 *
 * Frozen lookups only — no runtime float, no model (I-E03/E04). A re-run on the same
 * grade yields the same decision. This is the CI-blocking gate: a high-risk recommendation
 * MUST be blocked when the tier is estimated/untrusted (quality-gate.test.ts).
 *
 * @see 02-architecture.md §2b (Phase 7)
 * @see cost-confidence.ts (produces the effective_confidence this gate reads)
 */

import type { DqLetterGrade } from './cost-confidence.js';

/** The frozen trust tiers. */
export type TrustTier = 'trusted' | 'estimated' | 'untrusted';

/**
 * gateMetric — map a letter grade to its trust tier. Frozen lookup, total over the enum.
 *   A+ | A | B → trusted ; C → estimated ; D → untrusted.
 */
export function gateMetric(grade: DqLetterGrade): TrustTier {
  switch (grade) {
    case 'A+':
    case 'A':
    case 'B':
      return 'trusted';
    case 'C':
      return 'estimated';
    case 'D':
      return 'untrusted';
  }
}

/**
 * The gate decision the read-path + recommendation surfaces consult. All four flags are
 * derived deterministically from the trust tier — there is exactly ONE source of truth
 * (the effective grade), no independent toggles that can drift.
 */
export interface GateDecision {
  /** The trust tier (trusted | estimated | untrusted). */
  tier: TrustTier;
  /** true only for trusted — the billing cap applies only to trusted data. */
  billingCapApplies: boolean;
  /** true only for trusted — estimated/untrusted is excluded from the marketing-mix model. */
  includedInMmm: boolean;
  /** true for estimated/untrusted — high-risk recommendations are BLOCKED below trusted. */
  blocksHighRiskRecommendation: boolean;
}

/**
 * evaluateGate — the full gate decision for an effective_confidence grade.
 *
 * Trusted (A+|A|B): billingCapApplies=true, includedInMmm=true, blocksHighRiskRecommendation=false.
 * Estimated (C) / Untrusted (D): billingCapApplies=false, includedInMmm=false,
 *   blocksHighRiskRecommendation=true.
 *
 * Deterministic; pure; frozen. No float, no model.
 */
export function evaluateGate(effective: DqLetterGrade): GateDecision {
  const tier = gateMetric(effective);
  const trusted = tier === 'trusted';
  return {
    tier,
    billingCapApplies: trusted,
    includedInMmm: trusted,
    blocksHighRiskRecommendation: !trusted,
  };
}
