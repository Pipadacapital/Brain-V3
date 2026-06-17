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

// Phase 1 analytics queries
export { getRevenueTimeseries } from './internal/application/queries/get-revenue-timeseries.js';
export type { RevenueTimeseriesResult, TimeseriesBucketDto } from './internal/application/queries/get-revenue-timeseries.js';
export { getKpiSummary } from './internal/application/queries/get-kpi-summary.js';
export type { KpiSummaryResult, KpiSummaryDto } from './internal/application/queries/get-kpi-summary.js';
export { getRecognitionBreakdown } from './internal/application/queries/get-recognition-breakdown.js';
export type { RecognitionBreakdownResult, RecognitionBreakdownDto } from './internal/application/queries/get-recognition-breakdown.js';
export { getRecentActivity } from './internal/application/queries/get-recent-activity.js';
export type { RecentActivityResult, RecentActivityRow } from './internal/application/queries/get-recent-activity.js';

// Phase 2 analytics queries
export { getOrdersTimeseries } from './internal/application/queries/get-orders-timeseries.js';
export type { OrdersTimeseriesResult, OrdersTimeseriesBucketDto } from './internal/application/queries/get-orders-timeseries.js';
export { getOrderStats } from './internal/application/queries/get-order-stats.js';
export type { OrderStatsResult, OrderStatsDto } from './internal/application/queries/get-order-stats.js';
export { getDataHealth } from './internal/application/queries/get-data-health.js';
export type { DataHealthResult, DataHealthVolumeBucket } from './internal/application/queries/get-data-health.js';
