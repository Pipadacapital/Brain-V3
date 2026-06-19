/**
 * recommendation.api.v1.ts — shared BFF read contracts for the decision engine (doc 09).
 *
 * Source of truth for the recommendation DTOs at the web↔core seam. The web parses BFF responses
 * against these so a drift in the recommendation shape fails loudly at the boundary.
 *
 * HONEST EMPTY (02-architecture.md): the list is a discriminated union on `state` — `no_data`
 * (no open recommendations) vs `has_data`. CONFIDENCE is a closed enum the engine never overstates
 * (doc 09 Part 7). Evidence money fields are bigint-minor strings (I-S07) — the UI never floats them.
 */
import { z } from 'zod';

export const ConfidenceSchema = z.enum(['Trusted', 'Estimated', 'Insufficient']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** Detector evidence — loosely typed (varies by detector); values are strings/numbers/bools only. */
export const RecommendationEvidenceSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
export type RecommendationEvidence = z.infer<typeof RecommendationEvidenceSchema>;

/** The learning loop's measured effectiveness: the detector's headline metric then-at-raise vs now. */
export const RecommendationOutcomeSchema = z.object({
  metric: z.string(),
  then: z.number(),
  now: z.number(),
  delta: z.number(),
  improved: z.boolean(),
});
export type RecommendationOutcome = z.infer<typeof RecommendationOutcomeSchema>;

export const RecommendationSchema = z.object({
  recommendation_id: z.string(),
  detector: z.string(),
  kind: z.enum(['risk', 'opportunity']),
  confidence: ConfidenceSchema,
  priority: z.number().int(),
  status: z.string(),
  title: z.string(),
  summary: z.string(),
  recommended_action: z.string(),
  evidence: RecommendationEvidenceSchema,
  outcome: RecommendationOutcomeSchema.nullable(),
  created_at: z.string(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const RecommendationsSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({ state: z.literal('has_data'), recommendations: z.array(RecommendationSchema) }),
]);
export type Recommendations = z.infer<typeof RecommendationsSchema>;

/** Result of running the detectors. */
export const GenerateRecommendationsResultSchema = z.object({
  raised: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
});
export type GenerateRecommendationsResult = z.infer<typeof GenerateRecommendationsResultSchema>;
