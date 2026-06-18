/**
 * Data Quality summary read seam (Phase 7 — feat-data-quality-engine, Track B).
 *
 * The SINGLE brand-scoped read that powers the stakeholder-visible Data Quality surface
 * (/data/quality). It reads ONLY the LATEST `dq_check_result` grade per (category, target)
 * — the append-only DQ grade store the stream-worker DQ executors write (migration 0035,
 * RLS FORCE per brand) — inside `withBrandTxn` (GUC set per-transaction; RLS-enforced,
 * NON-INERT under brain_app; MEMORY: dev-db-superuser-masks-rls), then computes the
 * confidence + gate OUTPUTS on the sole metric-engine path:
 *
 *   cost_confidence      = computeCostConfidence(latest cost-relevant grades)   [floor]
 *   effective_confidence = min(cost_confidence, attribution_confidence)         [ordinal min]
 *   gate decision        = evaluateGate(effective_confidence)                    [trust tier]
 *
 * INVARIANTS:
 *   - Confidence/grade is a metric-engine OUTPUT computed deterministically at READ time
 *     (I-ST01) — NEVER a persisted float. `dq_check_result` stores raw outcomes + the frozen
 *     letter grade only; this query derives cost/effective confidence + the tier each read.
 *   - The UI NEVER queries `dq_check_result` directly — it reads ONLY this (via the BFF).
 *   - FAIL-CLOSED + resilient-to-parallel-build: `dq_check_result` is landed by the parallel
 *     Track A migration (0035). Until it runs, the relation does not exist (42P01) → honest
 *     state:'no_data' (never an error, never a fabricated grade). Mirrors get-capi-feedback.ts.
 *   - NO money column here — DQ stores grades, not money. cost_confidence reads spend/settlement
 *     FRESHNESS/COMPLETENESS/RECONCILIATION grades, never re-floats money (money stays BIGINT).
 *
 * @see 02-architecture.md §2c (Phase 7)
 */

import type {
  EngineDeps,
  DqLetterGrade,
  AttributionConfidenceGrade,
} from '@brain/metric-engine';
import {
  withBrandTxn,
  computeCostConfidence,
  computeEffectiveConfidence,
  evaluateGate,
  minGrade,
  LETTER_GRADE_BY_CONFIDENCE,
  type GateDecision,
  type TrustTier,
} from '@brain/metric-engine';

/** Postgres error code for "relation does not exist" (table not yet migrated by Track A). */
const UNDEFINED_TABLE = '42P01';

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === UNDEFINED_TABLE
  );
}

/** The frozen DQ categories (mirrors the dq_check_result.category CHECK). */
export type DqCategory = 'freshness' | 'completeness' | 'schema_validity' | 'reconciliation';

/** The freshness-SLA status the UI renders (green / at-risk / breached) — text+icon, never colour-only. */
export type FreshnessSlaStatus = 'green' | 'at_risk' | 'breached';

/**
 * The COST-RELEVANT (category, target) set whose latest grades floor cost_confidence.
 * Spend/settlement freshness + completeness + reconciliation (the cost half of the
 * effective_confidence formula). Targets match the stream-worker executors' `target` values.
 */
const COST_RELEVANT: ReadonlyArray<{ category: DqCategory; target: string }> = [
  { category: 'freshness', target: 'ad_spend_ledger' },
  { category: 'freshness', target: 'realized_revenue_ledger' },
  { category: 'completeness', target: 'ad_spend_ledger' },
  { category: 'completeness', target: 'realized_revenue_ledger' },
  { category: 'reconciliation', target: 'silver.order_state' },
] as const;

/**
 * Expected (category, target) coverage — the denominator for the dq_grade COVERAGE success
 * metric. The numerator is the count of distinct (category, target) that actually have a
 * latest graded row. Frozen list (the checks the executors are wired to run).
 */
const EXPECTED_COVERAGE: ReadonlyArray<{ category: DqCategory; target: string }> = [
  { category: 'freshness', target: 'bronze_events' },
  { category: 'freshness', target: 'connector_sync_status' },
  { category: 'freshness', target: 'silver.order_state' },
  { category: 'freshness', target: 'ad_spend_ledger' },
  { category: 'freshness', target: 'realized_revenue_ledger' },
  { category: 'completeness', target: 'bronze_events' },
  { category: 'completeness', target: 'ad_spend_ledger' },
  { category: 'completeness', target: 'realized_revenue_ledger' },
  { category: 'schema_validity', target: 'collector_events' },
  { category: 'reconciliation', target: 'silver.order_state' },
] as const;

/** One latest grade row per (category, target) the UI renders in the grade matrix. */
export interface DqGradeRow {
  category: DqCategory;
  /** The table/topic/subject checked (e.g. 'bronze_events', 'silver.order_state'). */
  target: string;
  /** The frozen letter grade (A+|A|B|C|D). */
  grade: DqLetterGrade;
  /** observed within threshold (drives the freshness-SLA green/breached signal). */
  passing: boolean;
  /** The raw measured signal as text (e.g. '42' minutes, '0.0123' null-rate). */
  observed: string;
  /** The SLA measured against (e.g. '60' max_age_minutes). */
  threshold: string;
  /** ISO timestamp of the check run. */
  checkedAt: string;
}

/** dq_grade coverage — the success metric (graded distinct (category,target) / expected). */
export interface DqCoverage {
  /** Distinct (category, target) that have at least one graded row. */
  graded: number;
  /** Expected distinct (category, target) the executors are wired to grade. */
  expected: number;
}

export type DataQualitySummaryResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      /** Latest grade per (category, target) — the grade matrix. */
      grades: DqGradeRow[];
      /** The freshness-SLA status across freshness checks (worst-of: breached > at_risk > green). */
      freshnessSla: FreshnessSlaStatus;
      /** dq_grade coverage (the success metric). */
      coverage: DqCoverage;
      /** cost_confidence — floor over the cost-relevant DQ grades (computed, not persisted). */
      costConfidence: DqLetterGrade;
      /** attribution_confidence — the Phase-5 grade the effective floor reads (best-available). */
      attributionConfidence: DqLetterGrade;
      /** effective_confidence = min(cost, attribution) — the single grade the gate + UI read. */
      effectiveConfidence: DqLetterGrade;
      /** The trust tier (trusted | estimated | untrusted). */
      tier: TrustTier;
      /** The full gate decision (cap / MMM / block-high-risk). */
      gate: GateDecision;
    };

/** Raw row shape from the latest-per-(category,target) query. */
interface LatestGradeRow {
  category: DqCategory;
  target: string;
  grade: DqLetterGrade;
  passing: boolean;
  observed: string;
  threshold: string;
  checked_at: Date;
}

/**
 * Fetch the latest `dq_check_result` grade per (category, target) for the brand, plus the
 * latest attribution_confidence letter. Returns null-ish honest no_data when the table is
 * not yet migrated or the brand has no graded rows.
 */
async function fetchLatestGrades(
  brandId: string,
  deps: EngineDeps,
): Promise<{ rows: LatestGradeRow[]; attribution: DqLetterGrade } | null> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    // DISTINCT ON (category, target) latest by checked_at — the index
    // idx_dq_check_result_latest (brand_id, category, target, checked_at DESC) serves this.
    let rows: LatestGradeRow[];
    try {
      const res = await client.query<LatestGradeRow>(
        `SELECT DISTINCT ON (category, target)
                category, target, grade, passing, observed, threshold, checked_at
         FROM dq_check_result
         WHERE brand_id = $1
         ORDER BY category, target, checked_at DESC`,
        [brandId],
      );
      rows = res.rows;
    } catch (err) {
      if (isUndefinedTable(err)) return null; // 0035 not yet migrated — honest no_data.
      throw err;
    }

    if (rows.length === 0) return null;

    // attribution_confidence: the latest letter grade stamped on the credit ledger. Best-
    // available; honest 'D' floor when no credit rows exist yet (no journey graded). Fail
    // closed to 'D' (lowest) if the attribution ledger is not yet migrated.
    const attribution = await fetchAttributionLetter(client, brandId);
    return { rows, attribution };
  });
}

/**
 * Letter (A/C/D) per the attribution_confidence frozen grade (mapped into the DQ enum via the
 * metric-engine LETTER_GRADE_BY_CONFIDENCE lookup — no float, no local re-grade).
 *
 * The credit ledger stamps `confidence_grade` (strong|partial|weak) per credit row. We take the
 * FLOOR (worst) distinct grade across the brand's rows so a single weak journey is not
 * optimistically hidden. No rows / ledger not migrated → honest 'D' floor.
 */
async function fetchAttributionLetter(
  client: {
    query: <R extends Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: R[] }>;
  },
  brandId: string,
): Promise<DqLetterGrade> {
  try {
    const res = await client.query<{ confidence_grade: string }>(
      `SELECT DISTINCT confidence_grade
       FROM attribution_credit_ledger
       WHERE brand_id = $1`,
      [brandId],
    );
    const grades = res.rows
      .map((r) => r.confidence_grade)
      .filter((g): g is AttributionConfidenceGrade => g === 'strong' || g === 'partial' || g === 'weak')
      .map((g) => LETTER_GRADE_BY_CONFIDENCE[g] as DqLetterGrade);
    if (grades.length === 0) return 'D'; // honest floor — no graded attribution yet.
    return grades.reduce((floor, g) => minGrade(floor, g));
  } catch (err) {
    if (isUndefinedTable(err)) return 'D'; // attribution ledger not migrated → honest floor.
    throw err;
  }
}

/**
 * getDataQualitySummary — the sole read for the Data Quality surface (BFF → this).
 *
 * @param brandId - Brand UUID (from session — D-1, never request body).
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getDataQualitySummary(
  brandId: string,
  deps: EngineDeps,
): Promise<DataQualitySummaryResult> {
  const fetched = await fetchLatestGrades(brandId, deps);
  if (fetched === null) return { state: 'no_data' };

  const { rows, attribution } = fetched;

  const grades: DqGradeRow[] = rows.map((r) => ({
    category: r.category,
    target: r.target,
    grade: r.grade,
    passing: r.passing,
    observed: r.observed,
    threshold: r.threshold,
    checkedAt: r.checked_at.toISOString(),
  }));

  // Freshness-SLA status: worst-of across freshness checks. A failing freshness check →
  // breached; a passing-but-low-grade (C) freshness check → at_risk; else green.
  const freshnessSla = computeFreshnessSla(grades);

  // dq_grade coverage (success metric): distinct (category,target) graded / expected.
  const gradedKeys = new Set(grades.map((g) => `${g.category}::${g.target}`));
  const coverage: DqCoverage = {
    graded: EXPECTED_COVERAGE.filter((e) => gradedKeys.has(`${e.category}::${e.target}`)).length,
    expected: EXPECTED_COVERAGE.length,
  };

  // cost_confidence: floor over the latest cost-relevant grades (computed, not persisted).
  const latestByKey = new Map(grades.map((g) => [`${g.category}::${g.target}`, g.grade]));
  const costGrades = COST_RELEVANT.map((c) => latestByKey.get(`${c.category}::${c.target}`)).filter(
    (g): g is DqLetterGrade => g !== undefined,
  );
  const costConfidence = computeCostConfidence(costGrades);
  const effectiveConfidence = computeEffectiveConfidence(costConfidence, attribution);
  const gate = evaluateGate(effectiveConfidence);

  return {
    state: 'has_data',
    grades,
    freshnessSla,
    coverage,
    costConfidence,
    attributionConfidence: attribution,
    effectiveConfidence,
    tier: gate.tier,
    gate,
  };
}

/** worst-of freshness status across the freshness grade rows. */
function computeFreshnessSla(grades: readonly DqGradeRow[]): FreshnessSlaStatus {
  const freshness = grades.filter((g) => g.category === 'freshness');
  if (freshness.length === 0) return 'green'; // no freshness signal → nothing breached.
  if (freshness.some((g) => !g.passing)) return 'breached';
  // passing but a low grade (C/D) → at-risk (within SLA but degraded headroom).
  if (freshness.some((g) => g.grade === 'C' || g.grade === 'D')) return 'at_risk';
  return 'green';
}
