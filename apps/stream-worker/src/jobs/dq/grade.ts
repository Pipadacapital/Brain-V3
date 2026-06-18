/**
 * dq/grade.ts — the FROZEN deterministic DQ grader (Tier-0, no model, no float drift).
 *
 * Phase 7 — Data Quality. A DQ check produces an exact measurement (row age in
 * minutes, null-rate ratio, schema-validity-failure ratio, row-count delta). This
 * module turns that measurement into a FROZEN letter grade (A+|A|B|C|D) via a fixed
 * band lookup. The bands are CONSTANTS; the only runtime arithmetic is a comparison
 * of the (already-measured) ratio against a constant band edge.
 *
 * DETERMINISM (I-E03/E04): the same (observed, threshold, category) ALWAYS yields the
 * same grade. A re-run on the same inputs produces an identical grade — no model, no
 * randomness, no time-dependence inside the grader.
 *
 * GRADE SEMANTICS (consistent with attribution-confidence.ts letter gate A/C/D):
 *   • freshness:   the "headroom" ratio = observed_age / max_age. 0 = brand-new,
 *                  1.0 = exactly at the SLA edge, >1.0 = breached. Fresher → higher grade.
 *   • completeness/schema_validity: the BADNESS ratio = null-rate / validity-failure-rate.
 *                  0 = perfect, higher = worse. Lower → higher grade.
 *   • reconciliation: the badness ratio = |delta| / max_delta (delta as a fraction of the
 *                  tolerance budget). 0 = exact match, 1.0 = at tolerance, >1.0 = breached.
 *
 * In every case we reduce the check to a single FAILURE FRACTION `f` in [0, ∞):
 *   f = 0      → perfect → A+
 *   f ≤ 0.25   → A
 *   f ≤ 0.50   → B   (the trusted floor — A+|A|B are "trusted")
 *   f ≤ 1.00   → C   (estimated — within SLA but degraded)
 *   f  > 1.00  → D   (untrusted — SLA breached)
 *
 * The trusted/estimated boundary (B|C) matches the gate: A+|A|B → trusted (billing-cap
 * applies, included in MMM); C → estimated; D → untrusted (excluded, blocks high-risk).
 */

export type DqLetterGrade = 'A+' | 'A' | 'B' | 'C' | 'D';

export type DqCategory = 'freshness' | 'completeness' | 'schema_validity' | 'reconciliation';

/**
 * FROZEN band table — upper-inclusive failure-fraction edges → letter grade.
 * Constants only; never recomputed at runtime.
 */
const GRADE_BANDS: ReadonlyArray<{ readonly maxFraction: number; readonly grade: DqLetterGrade }> = [
  { maxFraction: 0.0, grade: 'A+' },
  { maxFraction: 0.25, grade: 'A' },
  { maxFraction: 0.5, grade: 'B' },
  { maxFraction: 1.0, grade: 'C' },
] as const;

/**
 * gradeFromFraction — the frozen lookup. `f` is the (already-measured) failure
 * fraction in [0, ∞). Returns the first band whose upper edge `f` does not exceed;
 * anything beyond the last band (f > 1.0, i.e. SLA breached) is 'D'.
 *
 * Pure + deterministic: same `f` → same grade, always.
 */
export function gradeFromFraction(f: number): DqLetterGrade {
  // Defensive: a negative or NaN measurement is treated as the worst case (untrusted),
  // never silently graded high (honest-failure, never a false A+).
  if (!Number.isFinite(f) || f < 0) return 'D';
  for (const band of GRADE_BANDS) {
    if (f <= band.maxFraction) return band.grade;
  }
  return 'D';
}

export interface GradeOutcome {
  readonly grade: DqLetterGrade;
  /** The failure fraction as an exact NUMERIC(5,4)-compatible string (or null for pure-age with no SLA ratio). */
  readonly score: string | null;
  /** observed within threshold (passing = grade is trusted/estimated within SLA, i.e. f ≤ 1.0). */
  readonly passing: boolean;
}

/** Clamp a fraction to the NUMERIC(5,4) range [0, 9.9999] for storage (the grade already captures >1.0). */
function toScoreString(f: number): string {
  if (!Number.isFinite(f) || f < 0) return '0.0000';
  const clamped = Math.min(f, 9.9999);
  return clamped.toFixed(4);
}

/**
 * gradeFreshness — observed age (minutes) vs max_age (minutes) SLA.
 * f = observedAgeMinutes / maxAgeMinutes. passing iff f ≤ 1.0 (within SLA).
 */
export function gradeFreshness(observedAgeMinutes: number, maxAgeMinutes: number): GradeOutcome {
  // A zero/invalid SLA is a config bug — fail closed to D rather than divide-by-zero.
  if (maxAgeMinutes <= 0 || !Number.isFinite(maxAgeMinutes)) {
    return { grade: 'D', score: null, passing: false };
  }
  const f = observedAgeMinutes / maxAgeMinutes;
  return { grade: gradeFromFraction(f), score: toScoreString(f), passing: f <= 1.0 };
}

/**
 * gradeBadnessRatio — a "lower is better" ratio (null-rate, validity-failure-rate)
 * vs its max-tolerated ratio. f = observedRatio / maxRatio.
 * When maxRatio is 0 (zero-tolerance), any observed > 0 → D, observed == 0 → A+.
 */
export function gradeBadnessRatio(observedRatio: number, maxRatio: number): GradeOutcome {
  if (!Number.isFinite(observedRatio) || observedRatio < 0) {
    return { grade: 'D', score: '0.0000', passing: false };
  }
  if (maxRatio <= 0) {
    // Zero-tolerance threshold: perfect → A+, anything above → D (breached).
    const f = observedRatio === 0 ? 0 : Number.POSITIVE_INFINITY;
    return {
      grade: gradeFromFraction(f),
      score: toScoreString(observedRatio),
      passing: observedRatio === 0,
    };
  }
  const f = observedRatio / maxRatio;
  return { grade: gradeFromFraction(f), score: toScoreString(observedRatio), passing: f <= 1.0 };
}

/**
 * gradeReconciliation — |delta| vs max_row_delta tolerance.
 * f = |delta| / max_row_delta. When max_row_delta is 0 (exact-match required), any
 * delta != 0 → D.
 */
export function gradeReconciliation(absDelta: number, maxDelta: number): GradeOutcome {
  const d = Math.abs(absDelta);
  if (maxDelta <= 0) {
    const f = d === 0 ? 0 : Number.POSITIVE_INFINITY;
    return { grade: gradeFromFraction(f), score: toScoreString(d === 0 ? 0 : 1), passing: d === 0 };
  }
  const f = d / maxDelta;
  return { grade: gradeFromFraction(f), score: toScoreString(f), passing: f <= 1.0 };
}
