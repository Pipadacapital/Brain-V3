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
// Contribution margin (CM1/CM2 — the True-CM2 moat). feat-cm2-cost-inputs.
export { computeContributionMargin } from './contribution-margin.js';
export type { ContributionMarginResult, CostConfidence } from './contribution-margin.js';
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

// Customer 360 (Gold) summary — re-platform Phase E
export { getCustomer360Summary } from './customer-360.js';
export type { Customer360Summary, Customer360Row } from './customer-360.js';
// Logistics shipment outcomes (Slice 2) — delivered/RTO/other + RTO% by courier/pincode,
// from the multi-source silver_shipment mart (GoKwik AWB + Shiprocket).
export { computeShipmentOutcomes } from './shipment-outcomes.js';
export type { ShipmentOutcomesResult, CourierOutcome, PincodeOutcome } from './shipment-outcomes.js';
// Storefront behavior — what shoppers browse/search/view, from silver_touchpoint (pixel auto-instr).
export { computeStorefrontBehavior } from './storefront-behavior.js';
export type { StorefrontBehaviorResult, PageTypeBucket, BrowsedItem } from './storefront-behavior.js';
export { computeCodMix } from './cod-mix.js';
export type { CodMixResult } from './cod-mix.js';
export { computeCheckoutFunnel } from './checkout-funnel.js';
export type { CheckoutFunnelResult } from './checkout-funnel.js';
export { computeRtoRiskDistribution } from './cod-rto-prediction.js';
export type { RtoRiskDistributionResult } from './cod-rto-prediction.js';

// Silver tier — order-status-mix (the FIRST Silver read; non-additive, ADR-004)
export { computeOrderStatusMix } from './order-status-mix.js';
export type {
  OrderStatusMixResult,
  OrderStatusMixBucket,
  OrderStatusMixRange,
  LifecycleState,
} from './order-status-mix.js';
// Silver tier — top-products (per-SKU rollup over silver.order_line; non-additive, ADR-004)
export { computeTopProducts } from './top-products.js';
export type {
  TopProductsResult,
  TopProductRow,
  TopProductsRange,
} from './top-products.js';
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
  clampReversalBasis,
} from './attribution-clawback.js';
export type { ClawbackInput, SavedCreditRow, ReversalReason } from './attribution-clawback.js';

export {
  computeAttributionReconciliationRate,
  reconcileAttributionWindow,
  attributionRatePct,
  isoDate,
  previousDayIso,
} from './attribution-reconciliation.js';
export type {
  AttributionReconciliationResult,
  ChannelContribution,
  ReconciliationWindowInputs,
} from './attribution-reconciliation.js';

export { computeChannelRoas } from './attribution-channel-roas.js';
export type { ChannelRoasRow } from './attribution-channel-roas.js';

// Phase 7 Data Quality (feat-data-quality-engine) — cost_confidence + effective_confidence.
// effective_confidence = min(cost_confidence, attribution_confidence). FROZEN grade lookups
// (no runtime float, no model — I-E03/E04); a computed metric OUTPUT read at metric-engine
// time, never a persisted float. cost_confidence = floor over the cost-relevant DQ grades.
export {
  GRADE_ORDINAL,
  minGrade,
  computeCostConfidence,
  computeEffectiveConfidence,
} from './cost-confidence.js';
export type { DqLetterGrade } from './cost-confidence.js';

// Phase 7 Data Quality — the quality gate (trust tier + recommendation/billing/MMM decision).
// Trusted (A+|A|B) → full recs + billing cap + MMM; Estimated (C)/Untrusted (D) → blocked,
// no cap, excluded from MMM. CI-blocking: blocks high-risk recommendations below trusted.
export { gateMetric, evaluateGate } from './quality-gate.js';
export type { TrustTier, GateDecision } from './quality-gate.js';
