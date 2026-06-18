/**
 * @brain/metric-engine — cost_confidence + effective_confidence (deterministic grade, Tier-0).
 *
 * Phase 7 completes the half of the formula Phase 5 declared but could not yet build:
 *
 *     effective_confidence = min(cost_confidence, attribution_confidence)
 *
 * `cost_confidence` is the FLOOR (minimum by ordinal) over the COST-RELEVANT DQ grades —
 * the spend / settlement freshness + completeness + reconciliation letter grades stamped
 * into `dq_check_result` by the stream-worker DQ executors. It is a metric-engine OUTPUT
 * computed deterministically at READ time over the sole metric-engine path (I-ST01) —
 * NOT a new persisted float. A re-run on the same grades yields the same grade.
 *
 * Mirrors `attribution-confidence.ts`: FROZEN constants, no runtime float arithmetic,
 * no model/LLM (I-E03/E04). The only operations here are ordinal comparisons over a
 * frozen lookup table.
 *
 * @see 02-architecture.md §2a (Phase 7)
 * @see attribution-confidence.ts (the frozen-grade companion)
 * @see METRICS.md row `effective_confidence`
 */

/** The frozen DQ letter-grade enum (matches dq_check_result.grade CHECK + the gating table). */
export type DqLetterGrade = 'A+' | 'A' | 'B' | 'C' | 'D';

/**
 * Frozen ordinal per grade — higher = better. The ONLY arithmetic in this file is an
 * integer comparison over this constant table; there is no runtime float.
 */
export const GRADE_ORDINAL: Readonly<Record<DqLetterGrade, number>> = {
  'A+': 5,
  A: 4,
  B: 3,
  C: 2,
  D: 1,
} as const;

/**
 * minGrade — the worse (lower-ordinal) of two grades. Deterministic, pure.
 * Ties return either (they are equal), so we return `a` on equality for stability.
 */
export function minGrade(a: DqLetterGrade, b: DqLetterGrade): DqLetterGrade {
  return GRADE_ORDINAL[b] < GRADE_ORDINAL[a] ? b : a;
}

/**
 * computeCostConfidence — the FLOOR over the cost-relevant DQ grades.
 *
 * cost_confidence is the minimum (worst) grade across the cost-relevant
 * (category, target) checks — spend/settlement freshness + completeness +
 * reconciliation. One weak signal floors the whole cost confidence.
 *
 * Honest-empty: with NO cost grades (no DQ data yet) → 'D' (untrusted). We never
 * default optimistic — absent data is the LOWEST confidence, not the highest.
 *
 * @param costGrades - the cost-relevant DQ letter grades (latest per (category,target)).
 * @returns the floor grade; 'D' when the set is empty.
 */
export function computeCostConfidence(costGrades: readonly DqLetterGrade[]): DqLetterGrade {
  if (costGrades.length === 0) return 'D';
  return costGrades.reduce((floor, g) => minGrade(floor, g));
}

/**
 * computeEffectiveConfidence — the single number the gate + UI read.
 *
 *     effective_confidence = min(cost_confidence, attribution_confidence)
 *
 * Pure ordinal min over the two frozen grades. Deterministic; no float, no model.
 *
 * @param cost        - cost_confidence (from computeCostConfidence).
 * @param attribution - attribution_confidence letter (A/C/D from attribution-confidence.ts;
 *                      a subset of DqLetterGrade — the ordinal comparison is total over the enum).
 * @returns the worse of the two grades.
 */
export function computeEffectiveConfidence(
  cost: DqLetterGrade,
  attribution: DqLetterGrade,
): DqLetterGrade {
  return minGrade(cost, attribution);
}
