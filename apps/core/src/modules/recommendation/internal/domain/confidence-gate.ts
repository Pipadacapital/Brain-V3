/**
 * confidence-gate.ts — enforce "confidence before decisions" on recommendations (P0, doc 09 Part 7).
 *
 * Brain's spine: Capture → Trust → Confidence → Insights → Decisions. A recommendation is a DECISION
 * prompt, so it may only be surfaced as ACTIONABLE when the brand's measured data confidence supports
 * it. The data-quality engine already computes the brand's effective_confidence + trust tier + gate
 * (quality-gate.ts); this PURE function applies that gate to a detector's finding at the surface.
 *
 * Two rules, both honest (never overstate — doc 09 Part 7):
 *   1) CEILING — a recommendation can never be shown more confidently than the brand's effective data
 *      trust. A detector that says "Trusted" on stale/unreconciled Silver is capped to the brand's
 *      real tier (so a fresh row count can't launder a stale foundation into false confidence).
 *   2) HIGH-RISK HOLD — a risk-kind recommendation tells the brand to take a costly mitigation; that
 *      needs a TRUSTED foundation. Below Trusted (gate.blocksHighRiskRecommendation) the rec is HELD —
 *      recorded, but surfaced as "waiting on data confidence" with a reason, NOT as an action.
 *
 * Held recommendations are NOT hidden — the UI shows them as a guided next step (improve the
 * foundation), which is the product vision: Build Trust → then Enable Decisions.
 */

/** The recommendation confidence enum (mirrors @brain/contracts ConfidenceSchema). */
export type Confidence = 'Trusted' | 'Estimated' | 'Insufficient';

/** TrustTier from the metric-engine quality gate. */
export type TrustTier = 'trusted' | 'estimated' | 'untrusted';

/** The slice of the brand's gate decision this function needs. */
export interface ConfidenceGateInputs {
  tier: TrustTier;
  /** True when the brand is below Trusted (Estimated/Untrusted) — high-risk recs must be held. */
  blocksHighRiskRecommendation: boolean;
}

export interface GatedConfidence {
  /** The confidence to SURFACE — never above the brand's effective data trust. */
  confidence: Confidence;
  /** True → not actionable; surface as "waiting on data confidence", never as a decision. */
  held: boolean;
  /** Why it's held (honest, user-facing). null when actionable. */
  heldReason: string | null;
}

const RANK: Record<Confidence, number> = { Insufficient: 0, Estimated: 1, Trusted: 2 };

/** The confidence ceiling implied by a trust tier. */
export function tierToConfidence(tier: TrustTier): Confidence {
  return tier === 'trusted' ? 'Trusted' : tier === 'estimated' ? 'Estimated' : 'Insufficient';
}

/** The weaker of two confidences (a rec is only as strong as its weakest input). */
export function minConfidence(a: Confidence, b: Confidence): Confidence {
  return RANK[a] <= RANK[b] ? a : b;
}

const HOLD_HIGH_RISK =
  'Held until your data foundation is Trusted — a risk action needs trusted data to act on.';
const HOLD_LOW_CONFIDENCE =
  'Held — the underlying data confidence is insufficient to act on this yet.';

/**
 * applyConfidenceGate — resolve a detector's finding into a surfaced confidence + held verdict.
 *
 * @param kind                 'risk' (high-stakes mitigation) | 'opportunity'.
 * @param detectorConfidence   what the detector reported from its own signal thresholds.
 * @param gate                 the brand's trust tier + high-risk-block flag.
 */
export function applyConfidenceGate(
  kind: 'risk' | 'opportunity',
  detectorConfidence: Confidence,
  gate: ConfidenceGateInputs,
): GatedConfidence {
  // Rule 1 — ceiling: never surface above the brand's effective data trust.
  let confidence = minConfidence(detectorConfidence, tierToConfidence(gate.tier));

  // Rule 2 — high-risk hold: a costly mitigation needs a Trusted foundation.
  if (gate.blocksHighRiskRecommendation && kind === 'risk') {
    return { confidence: 'Insufficient', held: true, heldReason: HOLD_HIGH_RISK };
  }
  // An opportunity (or any rec) that floors to Insufficient is also not actionable.
  if (confidence === 'Insufficient') {
    return { confidence, held: true, heldReason: HOLD_LOW_CONFIDENCE };
  }
  return { confidence, held: false, heldReason: null };
}
