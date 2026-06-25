/**
 * Public interface for the `ml` module (core monolith bounded context) — DB-AUDIT C5 ML platform.
 * RULE: only this file may be imported by other modules — enforced by the ESLint boundary rule.
 * All implementation lives under ./internal/ and is private.
 *
 * Scope (C5): the application + serving layer over the `ml` schema (migration 0083, applied):
 *   - listModels      — the brand's model registry (ml.model_registry, RLS-scoped).
 *   - promoteModel    — gated stage transition; promoting to production archives the prior production
 *                       model of the same (brand,name) in ONE txn (partial-unique invariant).
 *   - serveCustomerScore — read the deterministic RFM/churn score from Gold, resolve the production
 *                       model (ml.model_registry, PG), append the served inference to the OPERATIONAL log
 *                       (StarRocks brain_ops.ops_ml_prediction_log — MV-2/DB-2 → V4 Phase 5; the PG
 *                       ml.prediction_log was dropped in 0103), return {model, score}.
 */
export { listModels } from './internal/application/queries/list-models.js';
export type { ModelDto, ListModelsDeps } from './internal/application/queries/list-models.js';

export {
  promoteModel,
  isModelStage,
  MODEL_STAGES,
  ModelNotFoundError,
  InvalidModelStageError,
  EvalGateError,
  runEvalGate,
  DEFAULT_EVAL_BASELINES,
  EVAL_GATE_METRIC_FLOORS,
} from './internal/application/promote-model.js';
export type {
  ModelStage,
  PromoteModelInput,
  PromoteModelDeps,
} from './internal/application/promote-model.js';

export { serveCustomerScore } from './internal/application/serve-customer-score.js';
export type {
  ServeCustomerScoreResult,
  ServeCustomerScoreDeps,
  ServedScore,
  ServingModel,
} from './internal/application/serve-customer-score.js';
