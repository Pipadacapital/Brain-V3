/**
 * ml.api.v1.ts — shared BFF contracts for the C5 ML platform (model registry + serving).
 *
 * Source of truth for the ML DTOs at the web↔core seam. The web parses BFF responses against these so
 * a drift in the shape fails loudly at the boundary.
 *
 * MONEY is bigint-minor STRINGS (I-S07) — never floated. HONEST EMPTY: the served-score result is a
 * discriminated union on `state` (`no_data` when the customer has no Gold score row vs `has_data`).
 */
import { z } from 'zod';

/** The closed set of model lifecycle stages (mirrors the 0083 CHECK constraint). */
export const ModelStageSchema = z.enum(['training', 'staging', 'production', 'archived']);
export type ModelStage = z.infer<typeof ModelStageSchema>;

/**
 * A model-registry row. metrics/feature_set are passthrough jsonb (loosely typed).
 * feature_set is naturally a LIST of feature names (array), but a future model may carry a richer
 * object spec — accept either so the contract never drifts on a valid jsonb shape.
 */
const JsonbPassthrough = z.union([
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);
export const ModelSchema = z.object({
  model_id: z.string(),
  name: z.string(),
  version: z.string(),
  stage: ModelStageSchema,
  framework: z.string(),
  feature_set: JsonbPassthrough.nullable(),
  metrics: JsonbPassthrough.nullable(),
  trained_at: z.string().nullable(),
  promoted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Model = z.infer<typeof ModelSchema>;

/** GET /api/v1/ml/models → the brand's registry (ordered name, then newest first). */
export const ModelListSchema = z.object({ models: z.array(ModelSchema) });
export type ModelList = z.infer<typeof ModelListSchema>;

/** The request body for POST /api/v1/ml/models/:id/promote. */
export const PromoteModelRequestSchema = z.object({ stage: ModelStageSchema });
export type PromoteModelRequest = z.infer<typeof PromoteModelRequestSchema>;

/** The serving model that owns a served prediction (null when no production model is registered). */
export const ServingModelSchema = z.object({
  model_id: z.string(),
  name: z.string(),
  version: z.string(),
  stage: z.string(),
  framework: z.string(),
});
export type ServingModel = z.infer<typeof ServingModelSchema>;

/** The served deterministic RFM/churn score payload. Money = bigint-minor strings. */
export const ServedScoreSchema = z.object({
  brain_id: z.string(),
  recency_score: z.number(),
  frequency_score: z.number(),
  monetary_score: z.number(),
  churn_risk: z.string(),
  lifetime_orders: z.string(),
  lifetime_value_minor: z.string(),
  days_since_last_order: z.number().nullable(),
  scored_on: z.string().nullable(),
  composite_score: z.number(),
});
export type ServedScore = z.infer<typeof ServedScoreSchema>;

/** GET /api/v1/ml/customer-score?brain_id=… → honest no_data / has_data. */
export const CustomerScoreResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data'), brain_id: z.string() }),
  z.object({
    state: z.literal('has_data'),
    model: ServingModelSchema.nullable(),
    score: ServedScoreSchema,
    prediction_id: z.string(),
  }),
]);
export type CustomerScoreResult = z.infer<typeof CustomerScoreResultSchema>;
