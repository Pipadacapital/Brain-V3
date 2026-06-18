/**
 * @brain/metric-engine — public API surface.
 *
 * The SOLE emitter of realized_revenue and provisional_revenue metrics.
 * Tier-0 deterministic — zero model calls, $0/mo, 0 tokens/day.
 * All money values are bigint minor units + CurrencyCode (no floats, I-S07).
 *
 * @see METRICS.md — metric definitions and rules
 * @see STACK.md locked choice 4 — "the only place a number is computed"
 */

// Re-export registry (D-1)
export {
  METRIC_REGISTRY,
  resolveMetric,
  type MetricId,
  type MetricVersion,
  type MetricDefinition,
} from './registry.js';

// Re-export deps (D-7, F-SEC-02)
export { type EngineDeps, withBrandTxn } from './deps.js';

// Re-export compute functions (D-5)
export { computeRealizedRevenue } from './realized-revenue.js';
export { computeProvisionalRevenue } from './provisional-revenue.js';

// Re-export Phase 1 analytics compute functions
export { computeRevenueTimeseries } from './revenue-timeseries.js';
export type { TimeGrain, TimeseriesBucket } from './revenue-timeseries.js';
export { computeKpiSummary } from './kpi-summary.js';
export type { KpiSummaryResult } from './kpi-summary.js';
export { computeRecognitionBreakdown } from './recognition-breakdown.js';
export type { RecognitionLabel, RecognitionBreakdownItem } from './recognition-breakdown.js';

// Phase 2 analytics compute functions
export { computeOrdersTimeseries } from './orders-timeseries.js';
export type { OrdersTimeseriesBucket } from './orders-timeseries.js';
export { computeOrderStats } from './order-stats.js';
export type { OrderStatsResult } from './order-stats.js';

// Razorpay settlement (net-of-fees) compute function (Track C)
export { computeSettlementSummary } from './settlement-summary.js';
export type { SettlementSummary, SettlementFee, SettlementFeeType } from './settlement-summary.js';

// Ad-connectors (Slice 1 Track 3) — spend + blended ROAS
export { computeAdSpendTimeseries } from './ad-spend-timeseries.js';
export type { AdSpendTimeseriesBucket, AdPlatform } from './ad-spend-timeseries.js';
export { computeBlendedRoas } from './blended-roas.js';
export type { BlendedRoasRow } from './blended-roas.js';

// GoKwik + Shopflo CoD/RTO surface (Track C) — RTO rates, CoD mix/CM2, checkout funnel
export { computeCodRtoRates } from './cod-rto-rates.js';
export type { CodRtoRatesResult, CodRtoCohort } from './cod-rto-rates.js';
export { computeCodMix } from './cod-mix.js';
export type { CodMixResult } from './cod-mix.js';
export { computeCheckoutFunnel } from './checkout-funnel.js';
export type { CheckoutFunnelResult } from './checkout-funnel.js';

// Silver tier — order-status-mix (the FIRST Silver read; non-additive, ADR-004)
export { computeOrderStatusMix } from './order-status-mix.js';
export type {
  OrderStatusMixResult,
  OrderStatusMixBucket,
  OrderStatusMixRange,
  LifecycleState,
} from './order-status-mix.js';
export { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
export type { SilverDeps, SilverPool, SilverConnection, SilverScope } from './silver-deps.js';

// Silver tier — journey seam (Phase 4: first-touch mix, stitch hit-rate, timeline; ADR-004)
export {
  computeFirstTouchMix,
  computeStitchHitRate,
  computeTouchpointTimeline,
} from './journey-mix.js';
export type {
  JourneyChannel,
  JourneyRange,
  FirstTouchMixResult,
  FirstTouchMixBucket,
  StitchHitRateResult,
  TouchpointTimelineResult,
  TouchpointTimelineRow,
  TimelineSelector,
} from './journey-mix.js';

// Phase 5 Attribution (feat-attribution-ledger) — the credit-ledger WRITER + readers.
// All Tier-0 deterministic (no model/prompt/dbt macro — I-E03/E04). Money signed BIGINT.
export {
  computeWeightUnits,
  apportionMinor,
  computeTouchCredits,
  weightFractionString,
  WEIGHT_SCALE,
  ATTRIBUTION_MODEL_IDS,
  DEFAULT_ATTRIBUTION_MODEL,
} from './attribution-models.js';
export type { AttributionModelId, TouchCredit, AttributionTouch } from './attribution-models.js';

export {
  gradeJourneyConfidence,
  isDeterministicChannel,
  ATTRIBUTION_CONFIDENCE_BY_GRADE,
  LETTER_GRADE_BY_CONFIDENCE,
} from './attribution-confidence.js';
export type {
  AttributionConfidenceGrade,
  AttributionConfidenceResult,
  ConfidenceTouchSignal,
} from './attribution-confidence.js';

export {
  computeAttributionCredit,
  computeCreditId,
  ATTRIBUTION_MODEL_VERSION,
} from './attribution-credit.js';
export type {
  AttributionCreditRow,
  AttributionRowKind,
  CreditInput,
  CreditTouch,
} from './attribution-credit.js';

export {
  computeAttributionClawback,
  computeClawbackCreditId,
  parseWeightFraction,
} from './attribution-clawback.js';
export type { ClawbackInput, SavedCreditRow, ReversalReason } from './attribution-clawback.js';

export { computeAttributionReconciliationRate } from './attribution-reconciliation.js';
export type {
  AttributionReconciliationResult,
  ChannelContribution,
} from './attribution-reconciliation.js';

export { computeChannelRoas } from './attribution-channel-roas.js';
export type { ChannelRoasRow } from './attribution-channel-roas.js';
