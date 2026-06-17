/**
 * Public interface for the `analytics` module (core monolith bounded context).
 * RULE: only this file may be imported by other modules — enforced by the ESLint
 * boundary rule. All implementation lives under ./internal/ and is private.
 * Spec: docs/05_Brain_Implementation_Build_Plan.md §3.
 *
 * Public surface (D-8):
 *   getRevenueMetrics — the sole read-path for revenue metrics (ADR-002).
 *   RevenueSnapshot   — the return type (discriminated union: no_data | has_data).
 */
export { getRevenueMetrics } from './internal/application/queries/get-revenue-metrics.js';
export type { RevenueSnapshot } from './internal/domain/metrics/revenue-snapshot.js';
