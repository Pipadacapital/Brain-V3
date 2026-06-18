/**
 * Public interface for the `data-quality` module (core monolith bounded context).
 * RULE: only this file may be imported by other modules — enforced by the ESLint
 * boundary rule. All implementation lives under ./internal/ and is private.
 *
 * Phase 7 (feat-data-quality-engine) — the read surface over the DQ grade store. The UI
 * reads ONLY through the BFF → these queries → the metric-engine sole read path (I-ST01);
 * the UI NEVER queries dq_check_result directly. Confidence/tier are computed metric OUTPUTS
 * (frozen letter grades, no persisted float), derived at read time.
 *
 *   getDataQualitySummary — the Data Quality surface: per-category × per-target latest grade,
 *                           freshness-SLA status, dq_grade coverage, cost/effective confidence,
 *                           and the gate decision (tier / cap / MMM / block-high-risk).
 *   getMetricTrust        — the single trust read the analytics read-path + recommendation
 *                           surfaces consult (effective_confidence + tier + gate).
 */
export { getDataQualitySummary } from './internal/application/queries/get-data-quality-summary.js';
export type {
  DataQualitySummaryResult,
  DqGradeRow,
  DqCoverage,
  DqCategory,
  FreshnessSlaStatus,
} from './internal/application/queries/get-data-quality-summary.js';

export { getMetricTrust } from './internal/application/queries/get-metric-trust.js';
export type { MetricTrustResult } from './internal/application/queries/get-metric-trust.js';
