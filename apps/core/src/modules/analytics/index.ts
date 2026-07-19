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
export { getRevenueMonthly } from './internal/application/queries/get-revenue-monthly.js';
export type { RevenueMonthlyResult, RevenueMonthlyRowDto } from './internal/application/queries/get-revenue-monthly.js';
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
// FX conversion for the "show amounts in the brand's primary currency" dashboard view (display-only).
export { fxRateService } from './internal/infrastructure/fx-rate-service.js';
export type { FxRateService } from './internal/infrastructure/fx-rate-service.js';
export { resolveBrandPrimaryCurrency, blendToPrimary, roasFromMinor } from './internal/infrastructure/fx-blend.js';
// Contribution margin (CM1/CM2) + cost inputs (feat-cm2-cost-inputs).
export { getContributionMargin } from './internal/application/queries/get-contribution-margin.js';
export type { ContributionMarginResult, ContributionMarginDto } from './internal/application/queries/get-contribution-margin.js';
export { listCostInputs, upsertCostInput } from './internal/application/queries/cost-inputs.js';
export type { CostInputDto, UpsertCostInputInput, CostScope, CostType } from './internal/application/queries/cost-inputs.js';
// SPEC:C.2.4 — per-SKU cost-sheet CSV ingest → billing.product_cost_sheet (versioned COGS source; DR-003).
export {
  parseCostSheetCsv,
  validateRows as validateProductCostRows,
  ingestProductCosts,
  listProductCosts,
} from './internal/application/queries/product-costs.js';
export type {
  ProductCostRow,
  ProductCostDto,
  IngestResult as ProductCostIngestResult,
  CostRowError as ProductCostRowError,
} from './internal/application/queries/product-costs.js';
// SPEC:C.5.1 — measurement-lineage endpoint (every executive metric → its Measurement facts).
export { getMetricLineage } from './internal/application/queries/get-metric-lineage.js';
export type { MetricLineageResult } from './internal/application/queries/get-metric-lineage.js';
// Top products — per-SKU rollup over Silver order-line (feat-shopify-order-depth).
export { getTopProducts } from './internal/application/queries/get-top-products.js';
export type { TopProductsResult, TopProductDto } from './internal/application/queries/get-top-products.js';
// Order-detail drill-down REMOVED: the per-order economic breakdown read Bronze directly (never-read-
// Bronze rule); the canonical order records + a per-record detail modal now live on the Data browser
// (mv_silver_order_state / mv_silver_order_line via queryConnectorRecords). No dashboard Bronze read remains.
// Product detail / affinity / treemap (P3) — per-product Gold marts over Trino serving views.
export { getProductDetail } from './internal/application/queries/get-product-detail.js';
export type { ProductDetailResult, ProductDetailDto } from './internal/application/queries/get-product-detail.js';
export { getProductAffinity } from './internal/application/queries/get-product-affinity.js';
export type { ProductAffinityResult, ProductAffinityPairDto } from './internal/application/queries/get-product-affinity.js';
export { getProductCategories } from './internal/application/queries/get-product-categories.js';
export type { ProductCategoriesResult, ProductCategoryNodeDto } from './internal/application/queries/get-product-categories.js';

// GoKwik + Shopflo CoD/RTO surface (Track C) — RTO rates, CoD mix/CM2, checkout funnel
export { getCodRtoRates } from './internal/application/queries/get-cod-rto-rates.js';
export { getCustomerBaseSummary } from './internal/application/queries/get-customer-360.js';
export type { CodRtoRatesResult, CodRtoCohortDto } from './internal/application/queries/get-cod-rto-rates.js';
// Saved segments (P2) — CRUD + preview over ops.saved_segment (operational state, PG ops schema).
export {
  listSavedSegments,
  createSavedSegment,
  updateSavedSegment,
  deleteSavedSegment,
  previewSegment,
} from './internal/application/queries/saved-segments.js';
export type {
  SavedSegmentDto,
  CreateSavedSegmentInput,
  UpdateSavedSegmentInput,
  SegmentPreviewResult,
} from './internal/application/queries/saved-segments.js';
// Logistics shipment outcomes (Slice 2) — delivered/RTO + RTO% by courier/pincode from silver_shipment.
export { getShipmentOutcomes } from './internal/application/queries/get-shipment-outcomes.js';
export type { ShipmentOutcomesResult, CourierOutcomeDto, PincodeOutcomeDto } from './internal/application/queries/get-shipment-outcomes.js';
// Operations delivery-time (P3) — per-courier avg delivery days + 5-bucket day histogram from gold_delivery_time.
export { getDeliveryTime } from './internal/application/queries/get-delivery-time.js';
export type { DeliveryTimeResult, DeliveryTimeCourierDto, DeliveryTimeBucketDto } from './internal/application/queries/get-delivery-time.js';
// Logistics return funnel (SR-10) — per-return_class breakdown + completion% from silver_return (SR-4).
export { getReturnFunnel } from './internal/application/queries/get-return-funnel.js';
export type { ReturnFunnelResult, ReturnClassBucketDto, ReturnCourierBucketDto } from './internal/application/queries/get-return-funnel.js';
// Storefront behavior — browse/search/view from silver_touchpoint (pixel auto-instrumentation).
export { getBehaviorOverview } from './internal/application/queries/get-behavior-overview.js';
export type { BehaviorOverviewResult, PageTypeBucketDto, BrowsedItemDto } from './internal/application/queries/get-behavior-overview.js';
// Storefront conversion funnel — sessions → product views → cart adds → purchases (Phase H pixel).
export { getFunnelAnalytics } from './internal/application/queries/get-funnel-analytics.js';
export type { FunnelAnalyticsResult, FunnelStageDto } from './internal/application/queries/get-funnel-analytics.js';
// Funnel STEP drill-down — paginated visitors who DROPPED at a step, over gold_funnel_user.
export { getFunnelUsers } from './internal/application/queries/get-funnel-users.js';
export type { FunnelUsersResult, FunnelUserDto, FunnelUsersParams, FunnelStep } from './internal/application/queries/get-funnel-users.js';
// Abandoned cart — cart sessions converted vs abandoned (Phase H pixel).
export { getAbandonedCart } from './internal/application/queries/get-abandoned-cart.js';
export type { AbandonedCartResult } from './internal/application/queries/get-abandoned-cart.js';
// Engagement — engaged (multi-touch) vs bounce sessions + avg touches (Phase H pixel).
export { getEngagement } from './internal/application/queries/get-engagement.js';
export type { EngagementResult } from './internal/application/queries/get-engagement.js';
// On-site search — page_type='search' slice of gold_behavior (P2 search-form endpoint).
export { getSearchBehavior } from './internal/application/queries/get-search-behavior.js';
export type { SearchBehaviorResult, SearchDayBucketDto } from './internal/application/queries/get-search-behavior.js';
// Lead-form submissions — gold_conversion_feedback (P2 search-form endpoint).
export { getFormConversion } from './internal/application/queries/get-form-conversion.js';
export type { FormConversionResult, FormBucketDto, FormDayBucketDto } from './internal/application/queries/get-form-conversion.js';
export { getCodMix } from './internal/application/queries/get-cod-mix.js';
export type { CodMixResult } from './internal/application/queries/get-cod-mix.js';
// DR-006 — the COD/RTO outcome funnel per currency from gold_cod_rto (mv_gold_cod_rto).
export { getCodRto } from './internal/application/queries/get-cod-rto.js';
export type { CodRtoResult, CodRtoCurrencyDto } from './internal/application/queries/get-cod-rto.js';
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
// Versioned journey ledger (mv_journey_events_current over iceberg.brain_gold.gold_journey_events) —
// one resolved customer's canonical timeline, newest-first, keyset-paginated (opaque cursor).
export { getJourneyEvents } from './internal/application/queries/get-journey-events.js';
export type { JourneyEventsResult, JourneyEventDto, JourneyEventsQueryParams } from './internal/application/queries/get-journey-events.js';
// SPEC: B.3 — Wave-B Journey APIs (AMD-14): per-customer timeline (cache→Trino fallback), per-order
// trace (explainability). Tenant from session (D-1). (The two-journey compare surface was removed
// in the Wave-3 cleanup — AUD-IMPL-020: zero consumers end-to-end.)
export { getCustomerJourney } from './internal/application/queries/get-customer-journey.js';
export type { CustomerJourneyParams } from './internal/application/queries/get-customer-journey.js';
export { getJourneyTrace } from './internal/application/queries/get-journey-trace.js';
export type { JourneyTraceParams } from './internal/application/queries/get-journey-trace.js';
// SPEC: B.4 — Journey Replay (?as_of=) + Explainability: the same customer's journey AS KNOWN AT
// as_of (retained version history, AMD-10) + identity_asof evidence. Batch-only, replayed:true.
export { getJourneyReplay } from './internal/application/queries/get-journey-replay.js';
export type {
  JourneyReplayResult,
  JourneyReplayQueryParams,
  IdentityAsOfStateDto,
  IdentityEvidenceDto,
} from './internal/application/queries/get-journey-replay.js';
// #32a — aggregate journey-path Sankey (top-N ordered channel paths + edges + drop-off) over
// gold_journey_paths via the metric-engine seam. NO money (paths are behavioral).
export { getJourneyPaths } from './internal/application/queries/get-journey-paths.js';
export type {
  JourneyPathsResult,
  JourneyPathRowDto,
  JourneyPathLinkDto,
  JourneyPathsParams,
} from './internal/application/queries/get-journey-paths.js';
export { getJourneyList } from './internal/application/queries/get-journey-list.js';
export type {
  JourneyListResult,
  JourneyListRowDto,
  JourneyListParams,
} from './internal/application/queries/get-journey-list.js';

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
export { getCampaignRoas } from './internal/application/queries/get-campaign-roas.js';
export type {
  CampaignRoasResult,
  CampaignRoasDto,
  CampaignRoasParams,
} from './internal/application/queries/get-campaign-roas.js';
export { getExecutiveMetrics } from './internal/application/queries/get-executive-metrics.js';
export type {
  ExecutiveMetricsResult,
  ExecutiveMetricDto,
  ExecutiveMetricsParams,
} from './internal/application/queries/get-executive-metrics.js';
export { getCohortRetention } from './internal/application/queries/get-cohort-retention.js';
export type {
  CohortRetentionResult,
  CohortRetentionDto,
} from './internal/application/queries/get-cohort-retention.js';
// Cohort-cell drill-down — paginated customers inside one (cohort_month × period) cell over
// gold_cohort_member, LTV-enriched from gold_customer_360 where available.
export { getCohortUsers } from './internal/application/queries/get-cohort-users.js';
export type {
  CohortUsersResult,
  CohortUserDto,
} from './internal/application/queries/get-cohort-users.js';
// #32b — time-to-2nd-purchase retention LATENCY (median + 6-bucket histogram) over gold_repeat_latency.
export { getRepeatLatency } from './internal/application/queries/get-repeat-latency.js';
export type {
  RepeatLatencyResult,
  RepeatLatencyBucketDto,
} from './internal/application/queries/get-repeat-latency.js';
// P3 — the UTM / acquisition-SOURCE matrix (visitors/conversions/revenue/avg_ltv/repeat) over gold_utm_source.
export { getUtmSource } from './internal/application/queries/get-utm-source.js';
export type {
  UtmSourceResult,
  UtmSourceRowDto,
} from './internal/application/queries/get-utm-source.js';
// #32c — per-campaign attributed revenue + ROAS (model-switchable) over gold_campaign_attribution.
export { getCampaignAttribution } from './internal/application/queries/get-campaign-attribution.js';
export type {
  CampaignAttributionResult,
  CampaignAttributionRowDto,
  CampaignAttributionParams,
} from './internal/application/queries/get-campaign-attribution.js';
// #32c-ts — date-bucketed per-campaign/channel attributed revenue (time-grain sibling of campaign-attribution).
export { getCampaignTimeseries } from './internal/application/queries/get-campaign-timeseries.js';
export type {
  CampaignTimeseriesResult,
  CampaignTimeseriesBucketDto,
  CampaignTimeseriesParams,
} from './internal/application/queries/get-campaign-timeseries.js';
// P3 — date × channel attributed revenue over the FULL credit ledger (mv_gold_attribution_credit).
export { getAttributedRevenueTimeseries } from './internal/application/queries/get-attributed-revenue-timeseries.js';
export type {
  AttributedRevenueTimeseriesResult,
  AttributedRevenueTimeseriesBucketDto,
  AttributedRevenueTimeseriesParams,
} from './internal/application/queries/get-attributed-revenue-timeseries.js';

// Insight + Opportunity Engine + AI Copilot briefing — deterministic insights over the Gold marts
// (gold_revenue_ledger / gold_executive_metrics / gold_customer_scores / gold_cac). Numbers come from
// the marts, never from a model; honest no_data when the brand has no realized rows.
export { getInsightsBriefing } from './internal/application/queries/get-insights-briefing.js';
export type {
  InsightsBriefingResult,
  BriefingDto,
  InsightDto,
} from './internal/application/queries/get-insights-briefing.js';

// ── Measurement-tier facade (WA-02, SPEC: 0.5) ──────────────────────────────────────────────
// packages/metric-engine is fenced to the measurement tier (I-ST03, D-6): non-measurement core
// modules (billing, ml, notification, recommendation, workspace-access) must NOT import the
// engine directly — the ESLint boundary fence rejects it and points HERE. This section is the
// SANCTIONED route: analytics (a measurement-tier module) re-exports exactly the narrow seam
// surface those modules legitimately consume. Nothing else from the engine is re-exported —
// in particular NOT withSilverBrand/BRAND_PREDICATE, so non-measurement modules cannot write
// ad-hoc serving SQL; every Gold read below is a purpose-named engine function.
//
// SilverPool is the driver-agnostic Trino serving-pool PORT type — deps typing only; the
// concrete adapter is injected by the composition root (apps/core/src/main.ts).
export type { SilverPool } from '@brain/metric-engine';
// billing — the billing meter + inspectable-bill Gold seams (D-3: money math lives in the engine).
export { computeRealizedGmvForPeriod, computeRealizedGmvCompositionForPeriod } from '@brain/metric-engine';
// ml — the Gold customer-score read (I-ST01: the engine is the SOLE Gold reader).
export { getCustomerScore } from '@brain/metric-engine';
// recommendation — the detector signal seams (RTO / realization / CM2 halves).
export {
  computeRtoRiskSignal,
  computeRealizationSignal,
  computeCm2RevenueSignal,
  computeCm2MarketingSignal,
} from '@brain/metric-engine';
// workspace-access — MA-11 currency_code immutability probe (any Gold ledger rows?).
export { brandHasRealizedLedgerRows } from '@brain/metric-engine';
// notification — the CAPI passback SOURCE window (finalized positive-amount purchases).
export { computeFinalizedPurchasesForWindow } from '@brain/metric-engine';
export type { FinalizedPurchaseWindowRow } from '@brain/metric-engine';
