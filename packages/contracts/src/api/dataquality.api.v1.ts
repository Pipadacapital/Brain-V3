/**
 * dataquality.api.v1 — Zod response contract for the Data Quality summary BFF READ DTO (#10).
 *
 * @see apps/core/.../data-quality/.../get-data-quality-summary.ts:103-147 (DataQualitySummaryResult)
 *
 * CRITICAL drift guards baked in:
 *  - The grade matrix field is `grades` (DqGradeRow[]), NOT `cells`. (historical drift)
 *  - There is NO `_minor` / money field — DQ carries GRADES, never money (the cost-confidence
 *    floor reads freshness/completeness/reconciliation grades, never re-floats money).
 *  - `state` discriminated union; `no_data` carries no has_data fields.
 *
 * The schema is NOT `.strict()` (additive core fields must not break web reads); the guard is
 * on MISSING / RENAMED / WRONG-TYPED required fields.
 */
import { z } from 'zod';
import { DqLetterGradeSchema, EngineTrustTierSchema } from './_money.js';

/** Mirrors `DqCategory` — get-data-quality-summary.ts:58. */
export const DqCategorySchema = z.enum([
  'freshness',
  'completeness',
  'schema_validity',
  'reconciliation',
]);
export type DqCategory = z.infer<typeof DqCategorySchema>;

/** Mirrors `FreshnessSlaStatus` — get-data-quality-summary.ts:61. */
export const FreshnessSlaStatusSchema = z.enum(['green', 'at_risk', 'breached']);
export type FreshnessSlaStatus = z.infer<typeof FreshnessSlaStatusSchema>;

/** One latest grade row per (category, target) — get-data-quality-summary.ts:103-117. */
export const DqGradeRowSchema = z.object({
  category: DqCategorySchema,
  target: z.string(),
  grade: DqLetterGradeSchema,
  passing: z.boolean(),
  observed: z.string(),
  threshold: z.string(),
  checkedAt: z.string(), // ISO timestamp (camelCase as core emits it)
});
export type DqGradeRow = z.infer<typeof DqGradeRowSchema>;

/** dq_grade coverage success metric — get-data-quality-summary.ts:120-125. */
export const DqCoverageSchema = z.object({
  graded: z.number(),
  expected: z.number(),
});
export type DqCoverage = z.infer<typeof DqCoverageSchema>;

/** The full gate decision — packages/metric-engine/src/quality-gate.ts:47-56 (GateDecision). */
export const GateDecisionSchema = z.object({
  tier: EngineTrustTierSchema,
  billingCapApplies: z.boolean(),
  includedInMmm: z.boolean(),
  blocksHighRiskRecommendation: z.boolean(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

export const DataQualitySummarySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    grades: z.array(DqGradeRowSchema), // NOT `cells`
    freshnessSla: FreshnessSlaStatusSchema,
    coverage: DqCoverageSchema,
    costConfidence: DqLetterGradeSchema,
    attributionConfidence: DqLetterGradeSchema,
    effectiveConfidence: DqLetterGradeSchema,
    tier: EngineTrustTierSchema,
    gate: GateDecisionSchema,
  }),
]);
export type DataQualitySummary = z.infer<typeof DataQualitySummarySchema>;
