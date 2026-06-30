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
export type { ContributionMarginResult, CostConfidence, ContributionMarginDeps } from './contribution-margin.js';
export { computeProvisionalRevenue } from './provisional-revenue.js';

// Re-export Phase 1 analytics compute functions
export { computeRevenueTimeseries } from './revenue-timeseries.js';
export type { TimeGrain, TimeseriesBucket } from './revenue-timeseries.js';
export { computeKpiSummary } from './kpi-summary.js';
export type { KpiSummaryResult } from './kpi-summary.js';
export { computeRecognitionBreakdown } from './recognition-breakdown.js';
export type { RecognitionLabel, RecognitionBreakdownItem } from './recognition-breakdown.js';
export { computeRevenueMonthly } from './revenue-monthly.js';
export type { RevenueMonthlyRow } from './revenue-monthly.js';

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
export { computeCac } from './cac.js';
// H9 — executive headline metrics (AOV/LTV/repeat_rate) + cohort retention over the Gold marts.
export { computeExecutiveMetrics, computeCohortRetention } from './executive-metrics.js';
export type {
  ExecutiveMetricsResult,
  ExecutiveMetricsRow,
  CohortRetentionResult,
  CohortRow,
} from './executive-metrics.js';
// B7 — repeat-purchase / returning-customer retention by acquisition cohort over the gold_retention mart.
export { computeRetention } from './retention.js';
export type { RetentionResult, RetentionCohortRow } from './retention.js';
// #32b — time-to-2nd-purchase retention LATENCY (median + 6-bucket histogram) over gold_repeat_latency.
export { computeRepeatLatency } from './repeat-latency.js';
export type { RepeatLatencyResult, RepeatLatencyBucket } from './repeat-latency.js';
// P3 — the UTM / acquisition-SOURCE matrix over gold_utm_source + the acquisition-source drilldown resolver.
export { computeUtmSource, getCustomerAcquisitionSourceMembers } from './utm-source.js';
export type { UtmSourceResult, UtmSourceRow } from './utm-source.js';
export { getCustomerCommerce } from './customer-commerce.js';
export type { CustomerCommerceProfile } from './customer-commerce.js';
export type { CacRow } from './cac.js';

// GoKwik + Shopflo CoD/RTO surface (Track C) — RTO rates, CoD mix/CM2, checkout funnel
export { computeCodRtoRates } from './cod-rto-rates.js';
export type { CodRtoRatesResult, CodRtoCohort } from './cod-rto-rates.js';

// Customer 360 (Gold) summary — re-platform Phase E
export { getCustomer360Summary } from './customer-360.js';
export type { Customer360Summary, Customer360Row } from './customer-360.js';
// Customer journey-intelligence (Gold) summary — V4 gold_journey rollup (NO money, NO PII; brain_anon_id key)
export { getCustomerJourneySummary } from './customer-journey.js';
export type { CustomerJourneySummary, CustomerJourneyRow } from './customer-journey.js';
// Single-customer RFM/churn score (Gold) — DB-AUDIT C5 ML serving
export { getCustomerScore } from './customer-score.js';
export type { CustomerScoreRow } from './customer-score.js';
// Customer-list BATCH enrichment (segment + LTV + order_count) + segment-membership filter (Gold scores).
export {
  getCustomerScoresForBrainIds,
  getCustomerSegmentMembers,
  deriveLifecycleSegment,
  isLifecycleSegment,
  LIFECYCLE_SEGMENTS,
} from './customer-scores-batch.js';
export type { CustomerScoreEnrichment } from './customer-scores-batch.js';
// Per-customer order list (Silver order-state fold) — backs the Customer 360 "Orders" sub-tab.
export { getCustomerOrders } from './customer-orders.js';
export type { CustomerOrderRow } from './customer-orders.js';
// AI/ML input feature vector (Gold ai_features serving mart) — V4 runtime Silver fold, not a precompute table.
export { getAiFeatures } from './ai-features.js';
export type { AiFeaturesResult, AiFeatureRow, AiFeaturesOptions } from './ai-features.js';
// Customer health/churn band (Gold) — V4 NET-NEW deterministic per-customer health surface.
export { getCustomerHealthSummary } from './customer-health.js';
export type { CustomerHealthSummary, CustomerHealthRow, HealthBand } from './customer-health.js';
// Customer segments (Gold) — deterministic value-tier + named lifecycle ladders over
// mv_gold_customer_segments (segment_type discriminates the two dimensions).
export { getCustomerSegments } from './customer-segments.js';
export type {
  CustomerSegmentsSummary,
  SegmentRow,
  SegmentType,
  LifecycleSegment,
  ValueTier,
} from './customer-segments.js';
// Recommendation INPUT features (Gold) — per-customer RFM + behaviour vectors over
// mv_gold_recommendation_features (RUNTIME Silver fold, NOT a permanent feature-precompute table).
export { getRecommendationFeatures } from './recommendation-features.js';
export type { RecommendationFeaturesResult, RecommendationFeatureRow } from './recommendation-features.js';
// Insight + Opportunity Engine (AI Copilot briefing source) — deterministic, over the Gold marts.
export { computeInsights } from './insights.js';
export type {
  InsightsResult,
  Insight,
  InsightKind,
  InsightSeverity,
  InsightConfidence,
} from './insights.js';
// Logistics shipment outcomes (Slice 2) — delivered/RTO/other + RTO% by courier/pincode,
// from the multi-source silver_shipment mart (GoKwik AWB + Shiprocket).
export { computeShipmentOutcomes } from './shipment-outcomes.js';
export type { ShipmentOutcomesResult, CourierOutcome, PincodeOutcome } from './shipment-outcomes.js';
// Operations delivery-time (P3) — per-courier avg delivery days + 5-bucket day histogram, from the
// gold_delivery_time mart (folded from silver_shipment dispatched→delivered terminal timestamps).
export { computeDeliveryTime } from './delivery-time.js';
export type { DeliveryTimeResult, CourierDeliveryTime, DeliveryTimeBucket } from './delivery-time.js';
// Logistics RETURN funnel (SR-10) — per-return_class breakdown + completion% from silver_return (SR-4).
// SEPARATE from shipment outcomes: returns NEVER carry terminal_class (no false-delivery leak).
export { computeReturnFunnel } from './return-funnel.js';
export type {
  ReturnFunnelResult,
  ReturnClass,
  ReturnClassBucket,
  ReturnCourierBucket,
} from './return-funnel.js';
// Storefront behavior — what shoppers browse/search/view, from silver_touchpoint (pixel auto-instr).
export { computeStorefrontBehavior } from './storefront-behavior.js';
export type { StorefrontBehaviorResult, PageTypeBucket, BrowsedItem } from './storefront-behavior.js';
export { computeStorefrontFunnel } from './storefront-funnel.js';
export type { StorefrontFunnelResult, FunnelStage, FunnelRange } from './storefront-funnel.js';
export { computeAbandonedCart } from './storefront-abandoned-cart.js';
export type { AbandonedCartResult, AbandonedCartRange } from './storefront-abandoned-cart.js';
export { computeStorefrontEngagement } from './storefront-engagement.js';
export type { StorefrontEngagementResult, EngagementRange } from './storefront-engagement.js';
// On-site search rollup — the page_type='search' slice of gold_behavior (P2 search-form endpoint).
export { computeSearchBehavior } from './search-behavior.js';
export type { SearchBehaviorResult, SearchBehaviorRange, SearchDayBucket } from './search-behavior.js';
// Lead-form submission rollup — gold_conversion_feedback (P2 search-form endpoint).
export { computeFormConversion } from './form-conversion.js';
export type { FormConversionResult, FormConversionRange, FormBucket, FormDayBucket } from './form-conversion.js';
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
export type { SilverDeps, SilverPool, SilverScope } from './silver-deps.js';

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

// #32a — aggregate journey-path Sankey (top-N ordered channel paths + edges + drop-off) over
// gold_journey_paths. NO money; the path-flow sibling of the per-touch journey-mix seam.
export { computeJourneyPaths } from './journey-paths.js';
export type { JourneyPathsResult, JourneyPathRow, JourneyPathLink } from './journey-paths.js';

// Phase 5 Attribution (feat-attribution-ledger) — the credit-ledger WRITER + readers.
// All Tier-0 deterministic (no model/prompt/dbt macro — I-E03/E04). Money signed BIGINT.
export {
  computeWeightUnits,
  apportionMinor,
  computeTouchCredits,
  computeTouchCreditsExplicit,
  normalizeWeightUnits,
  weightFractionString,
  integerNthRoot,
  timeDecayRawWeights,
  WEIGHT_SCALE,
  TIME_DECAY_DEFAULT_HALF_LIFE,
  TIME_DECAY_PRECISION,
  ATTRIBUTION_MODEL_IDS,
  PER_JOURNEY_MODEL_IDS,
  ALL_ATTRIBUTION_MODEL_IDS,
  DEFAULT_ATTRIBUTION_MODEL,
} from './attribution-models.js';
export type { AttributionModelId, TouchCredit, AttributionTouch } from './attribution-models.js';

// Billing meter seam — per-period realized GMV from the lakehouse (gold), the PG-function replacement.
export { computeRealizedGmvForPeriod } from './realized-gmv-period.js';
export type { RealizedGmvForPeriod } from './realized-gmv-period.js';
// Inspectable-bill seam — per-event_type composition of a period's realized GMV from the lakehouse.
export { computeRealizedGmvCompositionForPeriod } from './realized-gmv-composition-period.js';
export type { RealizedGmvCompositionLine } from './realized-gmv-composition-period.js';
// Recommendation signal seams — RTO / realization / CM2-revenue raw aggregates from the lakehouse gold
// ledger (the PG rto_risk_signal_for_brand / realization_signal_for_brand / cm2 revenue-half replacement).
export {
  computeRtoRiskSignal,
  computeRealizationSignal,
  computeCm2RevenueSignal,
  computeCm2MarketingSignal,
} from './recommendation-signals.js';
export type {
  RtoRiskSignalRaw,
  RealizationSignalRaw,
  Cm2RevenueSignalRaw,
  Cm2MarketingSignalRaw,
} from './recommendation-signals.js';

// Data-driven (Markov removal-effect) attribution — the GLOBAL, corpus-trained model.
export {
  computeMarkovChannelWeights,
  dataDrivenTouchWeightUnits,
} from './attribution-datadriven.js';
export type { DataDrivenJourney, MarkovResult } from './attribution-datadriven.js';

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
  computeAttributionCreditDataDriven,
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

// H8 — campaign/ad-level ROAS (the granular sibling of channel ROAS; joins on campaign_id).
export { computeCampaignRoas } from './attribution-campaign-roas.js';
export type { CampaignRoasRow } from './attribution-campaign-roas.js';

// #32c — per-campaign attributed revenue + spend + ROAS over the gold_campaign_attribution mart
// (model-switchable; pre-rolled to campaign grain — the served sibling of computeCampaignRoas).
export { computeCampaignAttribution } from './campaign-attribution.js';
export type { CampaignAttributionResult, CampaignAttributionRow } from './campaign-attribution.js';

// #32c-ts — date-bucketed per-campaign/channel attributed revenue (the time-grain sibling of
// computeCampaignAttribution; reads the date-bearing mv_gold_marketing_attribution it rolls up from).
export { computeCampaignTimeseries } from './campaign-timeseries.js';
export type { CampaignTimeseriesBucket } from './campaign-timeseries.js';

// P3 — date × channel attributed revenue over the FULL credit ledger serving view
// (mv_gold_attribution_credit). The channel-grain sibling of computeCampaignTimeseries.
export { computeAttributedRevenueTimeseries } from './attributed-revenue-timeseries.js';
export type { AttributedRevenueTimeseriesBucket } from './attributed-revenue-timeseries.js';

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

// ── Trino ad-hoc exploration PORT (ADDITIVE, READ-ONLY — NOT a serving dependency) ──
// brain_serving.mv_* (StarRocks) is the SOLE app/BFF/metric-engine serving path.
// Trino is operator/explicit ad-hoc exploration only. Known metrics NEVER route here.
// The AI-ad-hoc-Trino path is DISABLED (routeAiAdHocTrino throws NotImplementedYet).
export { withTrinoBrand } from './trino-deps.js';
export type { TrinoPool, TrinoQueryPort, TrinoScope, WithTrinoBrandOptions } from './trino-deps.js';
// Concrete Trino HTTP adapter (composition root injects via createTrinoPool).
export { createTrinoPool } from './trino-adapter.js';
export type { TrinoAdapterConfig } from './trino-adapter.js';

// ── Analytics cache PORT (brand_id-leading composite keys + stampede guard) ──
export { buildCacheKey, IoredisCacheAdapter } from './analytics-cache.js';
export type { AnalyticsCachePort, RedisCacheClient } from './analytics-cache.js';

// ── Serving cache reader (Redis-fronted hot serving reads over the Trino seam) ──
export { createServingCacheReader, hashParams } from './serving-cache.js';
export type { ServingCacheReader, ServingCacheReaderConfig } from './serving-cache.js';

// ── Query routing (known metrics → StarRocks; AI-Trino DISABLED) ──────────────
export {
  QueryRoute,
  routeKnownMetric,
  routeAiAdHocTrino,
  NotImplementedYet,
} from './query-route.js';
export type { KnownMetricRoute } from './query-route.js';
