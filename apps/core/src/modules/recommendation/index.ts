/**
 * Public interface for the `recommendation` module (core monolith bounded context).
 * RULE: only this file may be imported by other modules — enforced by the ESLint
 * boundary rule. All implementation lives under ./internal/ and is private.
 *
 * Scope (P1, slice 1 — the deterministic decision engine, doc 09): run registered detectors over
 * certified signals → emit ranked risk/opportunity recommendations with confidence + evidence,
 * recorded in the append-only Decision Log; read the open recommendations (the Morning Brief).
 * Recommend-only — nothing is auto-executed.
 */
export { generateRecommendations } from './internal/application/generate-recommendations.js';
export type { GenerateResult } from './internal/application/generate-recommendations.js';
// Insight + Opportunity Engine → recommendations bridge (converges the Gold-mart insight detectors
// into the one audited decision/action/outcome loop — the RGUD substrate).
export { materializeInsightsAsRecommendations } from './internal/application/materialize-insights.js';
export type {
  InsightForRecommendation,
  MaterializedInsight,
  MaterializeInsightsDeps,
} from './internal/application/materialize-insights.js';
export { measureRecommendationOutcomes } from './internal/application/measure-recommendation-outcomes.js';
export type { MeasureResult } from './internal/application/measure-recommendation-outcomes.js';
export { getRecommendations } from './internal/application/queries/get-recommendations.js';
export type {
  Recommendations,
  Recommendation,
  RecommendationEvidence,
  RecommendationOutcome,
} from './internal/application/queries/get-recommendations.js';
export {
  recordRecommendationAction,
  isRecommendationAction,
  RecommendationNotFoundError,
  InvalidRecommendationActionError,
} from './internal/application/record-recommendation-action.js';
export type {
  RecommendationAction,
  RecommendationActionKind,
  RecordRecommendationActionInput,
} from './internal/application/record-recommendation-action.js';
