/**
 * ask.api.v1 — Zod response contract for the Ask-Brain BFF READ DTO (#11).
 *
 * @see apps/core/.../ai/internal/ask-brain.ts:43-72 (AskBrainResult, ComputedNumber, AskBrainBinding)
 * @see apps/core/.../ai/provenance/ai-provenance.dto.ts:14-26 (ConfidenceGrade, TrustTier)
 * @see packages/ai-gateway-client/src/resolver-schema.ts:52-56 (ResolvedParams)
 *
 * CRITICAL: the discriminant is `kind` ('answer' | 'refusal'), NOT `state`.
 *
 * Money lives ONLY inside ComputedNumber.money as a MoneyRecord (bigint-minor strings) when
 * figure_kind='money' — NEVER a float, NEVER /100. `money` is null when figure_kind='none'
 * or no_data (honest empty). The number is NOT widened with optional has-money fields.
 *
 * Schema is NOT `.strict()`; the guard is on MISSING / RENAMED / WRONG-TYPED required fields.
 */
import { z } from 'zod';
import { MoneyRecordSchema } from './_money.js';

/** Mirrors `ConfidenceGrade` — ai-provenance.dto.ts:14. */
export const ConfidenceGradeSchema = z.enum(['A+', 'A', 'B', 'C', 'D']);
export type ConfidenceGrade = z.infer<typeof ConfidenceGradeSchema>;

/** Mirrors `TrustTier` (UI casing) — ai-provenance.dto.ts:17. */
export const TrustTierSchema = z.enum(['Trusted', 'Estimated', 'Untrusted']);
export type TrustTier = z.infer<typeof TrustTierSchema>;

/** Mirrors `MetricVersion` = `v${number}` — packages/metric-engine/src/registry.ts:34. */
export const MetricVersionSchema = z.string().regex(/^v\d+$/, 'metric_version must be v<number>');
export type MetricVersion = z.infer<typeof MetricVersionSchema>;

/**
 * Mirrors `ResolvedParams` — resolver-schema.ts:52-56. All keys optional; channel is the
 * known allow-list enum. NOT `.strict()` — the resolver guarantees the allow-list upstream,
 * and this is a read echo.
 */
export const ResolvedParamsSchema = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  channel: z
    .enum([
      'paid_meta',
      'paid_google',
      'paid_tiktok',
      'paid',
      'email',
      'organic_social',
      'referral',
      'direct',
    ])
    .optional(),
});
export type ResolvedParams = z.infer<typeof ResolvedParamsSchema>;

/**
 * A non-money certified scalar (ratio / percent). `value` is the canonical machine string the
 * engine produced (exact decimal, never a float re-derive); `display` is the formatted surface
 * ("3.42×", "12.50%"). `currency_code` is the currency the scalar pertains to (ROAS/RTO are read
 * per currency) — surfaced only for single-currency brands; multi-currency falls to figure_kind
 * 'none' (a blended ratio across currencies is not one number).
 */
export const AskScalarSchema = z.object({
  value: z.string(),
  display: z.string(),
  unit: z.enum(['ratio', 'percent']),
  currency_code: z.string().nullable(),
});
export type AskScalar = z.infer<typeof AskScalarSchema>;

/**
 * The certified, reproducible number — ask-brain.ts (ComputedNumber). Money lives in `money`
 * (per-currency bigint-minor strings) iff figure_kind='money'; a ratio/percent lives in `scalar`
 * iff figure_kind='ratio'|'percent'. figure_kind='none' = a valid binding whose figure isn't a
 * single surfaced scalar (a distribution/timeline — see its dashboard). `no_data` = honest empty.
 */
export const ComputedNumberSchema = z.object({
  figure_kind: z.enum(['money', 'ratio', 'percent', 'none']),
  money: MoneyRecordSchema.nullable(), // present iff figure_kind='money' and has data
  scalar: AskScalarSchema.nullable(), // present iff figure_kind='ratio'|'percent' and has data
  no_data: z.boolean(),
});
export type ComputedNumber = z.infer<typeof ComputedNumberSchema>;

/** The validated binding — ask-brain.ts:52-57 (AskBrainBinding). */
export const AskBrainBindingSchema = z.object({
  metric_id: z.string(),
  metric_version: MetricVersionSchema,
  params: ResolvedParamsSchema,
  snapshot_id: z.string(),
});
export type AskBrainBinding = z.infer<typeof AskBrainBindingSchema>;

export const AskBrainResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('answer'),
    binding: AskBrainBindingSchema,
    number: ComputedNumberSchema,
    confidence_grade: ConfidenceGradeSchema,
    trust_tier: TrustTierSchema,
    provenance_id: z.string(),
  }),
  z.object({
    kind: z.literal('refusal'),
    reason: z.string(),
  }),
]);
export type AskBrainResult = z.infer<typeof AskBrainResultSchema>;
