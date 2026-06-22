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
  /** The SURFACED confidence — gated to never exceed the brand's effective data trust (doc 09 Part 7). */
  confidence: ConfidenceSchema,
  priority: z.number().int(),
  status: z.string(),
  title: z.string(),
  summary: z.string(),
  recommended_action: z.string(),
  evidence: RecommendationEvidenceSchema,
  outcome: RecommendationOutcomeSchema.nullable(),
  created_at: z.string(),
  /**
   * Confidence gate (P0): true → NOT actionable, the brand's data foundation isn't trusted enough
   * to act on this yet. The UI surfaces held items as a guided "improve your foundation" next step,
   * never as a decision. `held_reason` is the honest, user-facing explanation (null when actionable).
   */
  held: z.boolean(),
  held_reason: z.string().nullable(),
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

/**
 * The human decision-feedback loop (DB-AUDIT M7). The closed set of actions a user can take on a
 * recommendation, recorded in the append-only action ledger (distinct from the system's outcome
 * measurement). 'accepted'/'served'/'snoozed' are audit-only; 'dismissed'/'reopened' move the
 * recommendation's lifecycle status.
 */
export const RecommendationActionKindSchema = z.enum([
  'served',
  'accepted',
  'dismissed',
  'snoozed',
  'reopened',
]);
export type RecommendationActionKind = z.infer<typeof RecommendationActionKindSchema>;

/** The request body for POST /api/v1/recommendations/:id/action. */
export const RecordRecommendationActionRequestSchema = z.object({
  action: RecommendationActionKindSchema,
  reason: z.string().max(2000).optional(),
});
export type RecordRecommendationActionRequest = z.infer<
  typeof RecordRecommendationActionRequestSchema
>;

/** The appended ledger row returned by the action endpoint. */
export const RecommendationActionSchema = z.object({
  action_id: z.string(),
  recommendation_id: z.string(),
  action: RecommendationActionKindSchema,
  actor: z.string(),
  reason: z.string().nullable(),
  created_at: z.string(),
});
export type RecommendationAction = z.infer<typeof RecommendationActionSchema>;
