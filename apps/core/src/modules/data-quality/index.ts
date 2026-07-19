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

// V4-pipeline observability: serving-tier freshness + per-mart row counts (brand-AGNOSTIC ops
// metadata read over StarRocks information_schema; see the query header for the no-tenant-seam rationale).
export { getServingFreshness } from './internal/application/queries/get-serving-freshness.js';
export type {
  ServingFreshnessResult,
  ServingMartRow,
  MartFreshness,
} from './internal/application/queries/get-serving-freshness.js';

// V4-pipeline observability: the "medallion journey" — whole-pipeline state (Bronze → Silver →
// Identity/Neo4j → Gold → Serving) from CHEAP METADATA ONLY (Iceberg counts/column-stats, the tiny
// watermark table, Neo4j counts). Brand-AGNOSTIC ops read; fail-soft per tier (never a 500). See header.
export { getMedallionJourney } from './internal/application/queries/get-medallion-journey.js';
export type {
  MedallionJourney,
  MedallionStageHealth,
  MedallionJourneyDeps,
  Neo4jPipelineCounts,
} from './internal/application/queries/get-medallion-journey.js';
// Concrete Neo4j identity-tier count reader (cheap, brand-agnostic) — constructed at the composition
// root and injected as the medallion-journey neo4jPipelineCounts port.
export { Neo4jPipelineCountsReader } from './internal/infrastructure/neo4j-pipeline-counts.js';
