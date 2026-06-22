/**
 * @brain/metric-engine — attribution_confidence (deterministic grade, Tier-0).
 *
 * Per METRICS.md, `attribution_confidence` feeds the Phase-6 consumers
 * (effective_confidence = min(cost_confidence, attribution_confidence)). Phase 5
 * produces it as a FIRST-CLASS deterministic grade — a fixed lookup over a
 * journey's touch-resolution signals, NEVER an invented float and NEVER a model
 * (I-E03/E04). The constants are FROZEN (no runtime float arithmetic).
 *
 * ── THE GRADE (floor over the journey's touch quality; 05-architecture.md §4) ──
 *   • strong  (A, 1.000): the journey deterministically STITCHED to the order
 *               (stitched=true) AND every credited touch is a DETERMINISTIC channel
 *               (carries a click-id / utm.medium — NOT the `direct` cookieless fallback).
 *   • partial (C, 0.700): stitched but ≥1 credited touch is the cookieless/`direct`
 *               residual bucket.
 *   • weak    (D, 0.400): UNSTITCHED / synthetic-enriched coverage (the dev-thin path).
 *
 * This maps onto the METRICS.md gating table: below the C/Insufficient line → rendered
 * "Estimated" at the edge. The grade + the numeric confidence are STAMPED onto each
 * credit row at credit time and carried VERBATIM onto the clawback row (same as the
 * saved weight) so a reversal never re-grades.
 *
 * @see 05-architecture.md §4
 * @see METRICS.md row `attribution_confidence`
 */

/** Deterministic confidence grade (frozen — no runtime floats). */
export type AttributionConfidenceGrade = 'strong' | 'partial' | 'weak';

/**
 * Frozen numeric confidence per grade. NUMERIC(4,3) on the ledger — these are the
 * canonical string values written to the ledger (exact, no float formatting at runtime).
 */
export const ATTRIBUTION_CONFIDENCE_BY_GRADE: Readonly<Record<AttributionConfidenceGrade, string>> = {
  strong: '1.000',
  partial: '0.700',
  weak: '0.400',
} as const;

/** Letter grade per confidence grade (the METRICS.md A/C/D gate mapping). */
export const LETTER_GRADE_BY_CONFIDENCE: Readonly<Record<AttributionConfidenceGrade, 'A' | 'C' | 'D'>> = {
  strong: 'A',
  partial: 'C',
  weak: 'D',
} as const;

/** The per-touch signal the grade floor reads (a projection of a Silver touch). */
export interface ConfidenceTouchSignal {
  /**
   * True iff the touch resolves to a DETERMINISTIC channel — it carries a click-id
   * (fbclid/gclid/ttclid) OR a utm.medium, i.e. it is NOT the cookieless `direct`
   * residual fallback.
   */
  isDeterministicChannel: boolean;
}

export interface AttributionConfidenceResult {
  grade: AttributionConfidenceGrade;
  /** The frozen numeric confidence string (NUMERIC(4,3)). */
  confidence: string;
  /** The letter grade for the gating table. */
  letter: 'A' | 'C' | 'D';
}

/**
 * gradeJourneyConfidence — the deterministic floor over a journey's touch signals.
 *
 * @param stitched - Whether the journey deterministically stitched to the order
 *                   (stitched_brain_id IS NOT NULL — the journey-mix stitch signal).
 * @param touches  - The CREDITED touches' channel signals (the touches that carry weight).
 * @returns The frozen grade + numeric confidence + letter.
 *
 * Rules (deterministic, in order):
 *   • not stitched                                  → weak (D, 0.400)
 *   • stitched, all touches deterministic channel   → strong (A, 1.000)
 *   • stitched, ≥1 cookieless/direct touch          → partial (C, 0.700)
 *   • zero credited touches (no journey)            → weak (D, 0.400) — honest dev-thin
 */
export function gradeJourneyConfidence(
  stitched: boolean,
  touches: readonly ConfidenceTouchSignal[],
): AttributionConfidenceResult {
  let grade: AttributionConfidenceGrade;
  if (!stitched || touches.length === 0) {
    grade = 'weak';
  } else if (touches.every((t) => t.isDeterministicChannel)) {
    grade = 'strong';
  } else {
    grade = 'partial';
  }
  return {
    grade,
    confidence: ATTRIBUTION_CONFIDENCE_BY_GRADE[grade],
    letter: LETTER_GRADE_BY_CONFIDENCE[grade],
  };
}

/** The canonical `direct` channel — the cookieless residual bucket (never deterministic). */
const COOKIELESS_CHANNEL = 'direct';

/**
 * isDeterministicChannel — derive the per-touch signal from a Silver touch projection.
 * A touch is deterministic if it carries any click-id OR a utm.medium AND its resolved
 * channel is not the `direct` fallback. Pure, deterministic.
 */
export function isDeterministicChannel(touch: {
  channel: string;
  utmMedium?: string | null;
  fbclid?: string | null;
  gclid?: string | null;
  ttclid?: string | null;
  msclkid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  dclid?: string | null;
}): boolean {
  if (touch.channel === COOKIELESS_CHANNEL) return false;
  const hasClickId =
    Boolean(touch.fbclid) || Boolean(touch.gclid) || Boolean(touch.ttclid) ||
    Boolean(touch.msclkid) || Boolean(touch.gbraid) || Boolean(touch.wbraid) || Boolean(touch.dclid);
  const hasMedium = Boolean(touch.utmMedium);
  return hasClickId || hasMedium;
}
