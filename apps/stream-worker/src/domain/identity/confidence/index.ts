/**
 * confidence/ — the Confidence Engine domain cluster.
 *
 * A pure domain service that aggregates the ENABLED deterministic matcher + deterministic strategy
 * hooks into a versioned, evidence-trailed `ConfidenceVerdict` (@brain/contracts). Deterministic
 * matching is the ONLY live path; probabilistic / ML / household / probabilistic-cross-device
 * strategies are registered-DISABLED and throw `NotImplementedYet` on invoke (never faked).
 *
 *   ConfidenceEngine     — score-aggregation core (integer 0–100, per-tenant bands, never-merge guarantee)
 *   strategyHooks        — merge / split / cross-device (deterministic, LIVE) + disabled hooks
 *   resolverBridge       — grade the existing IdentityResolver's decision (wrap, don't replace)
 */
export {
  ConfidenceEngine,
  DEFAULT_CONFIDENCE_CONFIG,
} from './ConfidenceEngine.js';
export type {
  ConfidenceBandThresholds,
  TenantConfidenceConfig,
  TenantConfidenceOverride,
  IdentifierMatch,
  ConfidenceEvidence,
  ConfidenceEngineOptions,
} from './ConfidenceEngine.js';

export {
  DeterministicMergeHook,
  DeterministicSplitHook,
  DeterministicCrossDeviceHook,
  DisabledStrategyHook,
  IDENTITY_STRATEGY_HOOK_REGISTRY,
  createDefaultStrategyHooks,
} from './strategyHooks.js';
export type {
  StrategyHookKind,
  StrategyEvidence,
  StrategyDetection,
  StrategyHook,
  StrategyHookDescriptor,
} from './strategyHooks.js';

export {
  evidenceFromResolver,
  gradeResolverOutcome,
} from './resolverBridge.js';
