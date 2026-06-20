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
// Data Foundation Health readiness verdict (P1) — pure aggregation of the health signals.
export { computeFoundationHealth, freshnessFromIngest } from './internal/application/foundation-health.js';
export type {
  FoundationHealth,
  FoundationSignals,
  FoundationTier,
  FoundationStep,
  FoundationDqTier,
  Freshness as FoundationFreshness,
} from './internal/application/foundation-health.js';
// Readiness-driven progressive unlock (P2) — eligibility for centers + connector categories.
export { computeEntitlements } from './internal/application/entitlements.js';
export type { Entitlements, EntitlementEntry, EntitlementInput } from './internal/application/entitlements.js';

// Razorpay settlement summary (net-of-fees) — Track C
export { getSettlementSummary } from './internal/application/queries/get-settlement-summary.js';
export type { SettlementSummaryResult, SettlementFeeDto } from './internal/application/queries/get-settlement-summary.js';

// Ad-connectors (Slice 1 Track 3) — spend timeseries + blended ROAS
export { getAdSpendTimeseries } from './internal/application/queries/get-ad-spend-timeseries.js';
export type { AdSpendTimeseriesResult, AdSpendTimeseriesBucketDto } from './internal/application/queries/get-ad-spend-timeseries.js';
export { getBlendedRoas } from './internal/application/queries/get-blended-roas.js';
export type { BlendedRoasResult, BlendedRoasDto } from './internal/application/queries/get-blended-roas.js';

// Tracking Center (pixel collection health — Phase 1 Track C)
export { getTrackingHealth } from './internal/application/queries/get-tracking-health.js';
export type { TrackingHealthResult, TrackingHealthVolumeBucket } from './internal/application/queries/get-tracking-health.js';
export { getRecentEvents } from './internal/application/queries/get-recent-events.js';
export type { RecentEventsResult, RecentEventRow } from './internal/application/queries/get-recent-events.js';
// Orders list — paginated latest-state orders from Bronze (feat-shopify-order-depth).
export { getOrdersList } from './internal/application/queries/get-orders-list.js';
export type { OrdersListResult, OrderListItemDto } from './internal/application/queries/get-orders-list.js';
// Top products — per-SKU rollup over Silver order-line (feat-shopify-order-depth).
export { getTopProducts } from './internal/application/queries/get-top-products.js';
export type { TopProductsResult, TopProductDto } from './internal/application/queries/get-top-products.js';
// Order detail — single order's economic breakdown from Bronze (feat-shopify-order-depth).
export { getOrderDetail } from './internal/application/queries/get-order-detail.js';
export type {
  OrderDetailResult,
  OrderDetailDto,
  OrderLineItemDto,
  OrderTaxLineDto,
  OrderDiscountCodeDto,
  OrderRefundDto,
} from './internal/application/queries/get-order-detail.js';

// GoKwik + Shopflo CoD/RTO surface (Track C) — RTO rates, CoD mix/CM2, checkout funnel
export { getCodRtoRates } from './internal/application/queries/get-cod-rto-rates.js';
export type { CodRtoRatesResult, CodRtoCohortDto } from './internal/application/queries/get-cod-rto-rates.js';
export { getCodMix } from './internal/application/queries/get-cod-mix.js';
export type { CodMixResult } from './internal/application/queries/get-cod-mix.js';
export { getCheckoutFunnel } from './internal/application/queries/get-checkout-funnel.js';
export type { CheckoutFunnelResult } from './internal/application/queries/get-checkout-funnel.js';
export { getRtoRiskDistribution } from './internal/application/queries/get-rto-risk-distribution.js';
export type { RtoRiskDistributionResult } from './internal/application/queries/get-rto-risk-distribution.js';

// Silver tier (feat-silver-tier-order-state) — order-status-mix via the Silver seam
export { getOrderStatusMix } from './internal/application/queries/get-order-status-mix.js';
export type { OrderStatusMixResult, OrderStatusMixRowDto, OrderStatusMixParams } from './internal/application/queries/get-order-status-mix.js';

// Phase 4 Journey (feat-journey-touchpoint) — first-touch mix / stitch-rate / timeline
// via the Silver seam over silver.touchpoint (ADR-004 non-additive in the engine).
export { getJourneyFirstTouchMix } from './internal/application/queries/get-journey-first-touch-mix.js';
export type { JourneyFirstTouchMixResult, FirstTouchMixRowDto, JourneyFirstTouchMixParams } from './internal/application/queries/get-journey-first-touch-mix.js';
export { getJourneyStitchRate } from './internal/application/queries/get-journey-stitch-rate.js';
export type { JourneyStitchRateResult, JourneyStitchRateParams } from './internal/application/queries/get-journey-stitch-rate.js';
export { getJourneyTimeline } from './internal/application/queries/get-journey-timeline.js';
export type { JourneyTimelineResult, TimelineTouchDto, JourneyTimelineParams } from './internal/application/queries/get-journey-timeline.js';

// D13 Consent / Compliance surface (feat-d13-consent-cancontact Track C) — the four
// brand-scoped reads behind /settings/consent. Counts + hashes only (NO raw PII);
// fail-closed when the consent SoR tables are not yet migrated (no consent == blocked).
export {
  getConsentCoverage,
  getConsentSuppressionSummary,
  getConsentGateActivity,
  getConsentWindowConfig,
} from './internal/application/queries/get-consent-compliance.js';
export type {
  ConsentCoverageResult,
  ConsentCoverageRow,
  ConsentSuppressionSummaryResult,
  ConsentGateActivityResult,
  GateActivityRow,
  GateDecision,
  ConsentWindowConfigResult,
} from './internal/application/queries/get-consent-compliance.js';

// Phase 6 Conversion-Feedback / CAPI surface (feat-capi-conversion-feedback Track C) — the
// three brand-scoped reads behind /analytics/conversion-feedback over capi_passback_log +
// capi_deletion_log (migration 0034). Counts + truncated event_id only (NO raw PII / no
// subject_hash); fail-closed 'no_data' when the 0034 tables are not yet migrated. The
// blocked_by_consent count is the SLO=0 (non_consented_sends) made VISIBLE; would_send_dev +
// dev_boundary surface the honest dev posture (matched & gated, but not sent — no live creds).
export {
  getCapiFeedbackSummary,
  getCapiFeedbackEvents,
  getCapiFeedbackDeletions,
} from './internal/application/queries/get-capi-feedback.js';
export type {
  CapiFeedbackSummaryResult,
  CapiFeedbackEventsResult,
  CapiFeedbackEventRow,
  CapiFeedbackDeletionsResult,
  CapiFeedbackDeletionRow,
  CapiPassbackStatus,
  CapiDeletionStatus,
} from './internal/application/queries/get-capi-feedback.js';

// Phase 5 Attribution (feat-attribution-ledger) — attributed-by-channel + reconciliation + channel ROAS
// over attribution_credit_ledger (Postgres Gold, 0032) via the metric-engine named seams (ADR-002).
export { getAttributionByChannel } from './internal/application/queries/get-attribution-by-channel.js';
export type {
  AttributionByChannelResult,
  ChannelContributionDto,
  AttributionByChannelParams,
} from './internal/application/queries/get-attribution-by-channel.js';
export { getAttributionReconciliation } from './internal/application/queries/get-attribution-reconciliation.js';
export type {
  AttributionReconciliationResultDto,
  AttributionReconciliationParams,
} from './internal/application/queries/get-attribution-reconciliation.js';
export { getChannelRoas } from './internal/application/queries/get-channel-roas.js';
export type {
  ChannelRoasResult,
  ChannelRoasDto,
  ChannelRoasParams,
} from './internal/application/queries/get-channel-roas.js';
