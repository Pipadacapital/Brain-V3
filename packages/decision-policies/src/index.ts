// SPEC: H
/**
 * @brain/decision-policies — versioned decision-policy definitions + a compiler SKELETON.
 *
 * SCAFFOLD ONLY (PLAN-OF-RECORD §PART 6.H): parse/validate the YAML policy SHAPE and resolve every
 * metric reference against the certified metric set. DEFERRED: evaluation engine, EV models,
 * arbitration — represented as the PolicyEvaluatorPort + a NotImplemented adapter (fail-closed,
 * behind the DEFAULT-OFF `decision.engine` flag).
 *
 * Public surface:
 *   compilePolicy / CompileResult / PolicyValidationError   — the compiler skeleton
 *   validatePolicy / ValidationResult                       — the shape validator
 *   CompiledPolicy + policy AST types                       — domain (port side)
 *   PolicyEvaluatorPort + DecisionRecord/CandidateEvaluation— DEFERRED evaluation seam
 *   NotImplementedPolicyEvaluator                           — the failing-by-design adapter
 *   CERTIFIED_METRICS / isCertifiedMetric                   — Wave D certified metric name set
 *   loadPolicyDocument                                      — DEFERRED YAML parse seam
 */

export { compilePolicy, PolicyValidationError, type CompileResult } from './compiler/compile.js';
export { validatePolicy, type ValidationResult } from './compiler/validate.js';
export {
  CERTIFIED_METRICS,
  isCertifiedMetric,
  type CertifiedMetric,
} from './domain/certified-metrics.js';
export type {
  ArbitrationStrategy,
  CandidateExpectedValue,
  CompiledPolicy,
  ConstraintOp,
  PolicyArbitration,
  PolicyCandidate,
  PolicyConstraint,
  PolicyMetadata,
  PolicySpec,
  SubjectType,
} from './domain/policy-types.js';
export type {
  CandidateEvaluation,
  DecisionRecord,
  DecisionSubject,
  PolicyEvaluatorPort,
} from './domain/evaluator-port.js';
export {
  NotImplementedError,
  NotImplementedPolicyEvaluator,
} from './adapters/not-implemented-evaluator.js';
export { loadPolicyDocument } from './io/load.js';
