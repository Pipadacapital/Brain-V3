// AUD-IMPL-006: extracted VERBATIM from the former 2,640-line apps/web/lib/api/client.ts
// (per-domain decomposition mirroring the backend CQ-1 split). Import from '@/lib/api/client'
// — the index re-exports this module's public surface unchanged.
import {
  AttributionByChannelSchema,
  AttributionReconciliationSchema,
  ChannelRoasSchema,
  JourneyFirstTouchMixSchema,
  ShipmentOutcomesSchema,
  ReturnFunnelSchema,
  BehaviorOverviewSchema,
  FunnelAnalyticsSchema,
  FunnelUsersSchema,
  AbandonedCartSchema,
  EngagementSchema,
  SearchBehaviorSchema,
  FormConversionSchema,
  JourneyTimelineSchema,
  JourneyEventsLedgerSchema,
  JourneyStitchRateSchema,
  JourneyPathsSchema,
  JourneyListSchema,
  RepeatLatencySchema,
  CohortUsersSchema,
  DeliveryTimeSchema,
  CodRtoSchema,
  UtmSourceSchema,
  CampaignAttributionSchema,
  CampaignTimeseriesSchema,
  AttributedRevenueTimeseriesSchema,
  OrderStatusMixSchema,
  TopProductsSchema,
  OrdersListSchema,
  ContributionMarginSchema,
  CostInputsListSchema,
  ProductDetailSchema,
  ProductAffinitySchema,
  ProductCategoriesSchema,
  DataQualitySummarySchema,
  FoundationHealthSchema,
  EntitlementsSchema,
} from '@brain/contracts';
import type {
  AnalyticsTimeseriesResponse,
  AnalyticsKpiSummaryResponse,
  AnalyticsExecutiveMetricsResponse,
  AnalyticsRecognitionBreakdownResponse,
  AnalyticsRevenueMonthlyResponse,
  AnalyticsRecentActivityResponse,
  AnalyticsOrdersTimeseriesResponse,
  AnalyticsOrderStatsResponse,
  AnalyticsDataHealthResponse,
  FoundationHealthResponse,
  EntitlementsResponse,
  DataQualitySummaryResponse,
  MedallionJourney,
  AnalyticsSettlementsResponse,
  AnalyticsTrackingHealthResponse,
  AnalyticsRecentEventsResponse,
  AnalyticsAdSpendTimeseriesResponse,
  AnalyticsBlendedRoasResponse,
  AnalyticsCodRtoRatesResponse,
  AnalyticsCodMixResponse,
  AnalyticsCheckoutFunnelResponse,
  AnalyticsCohortRetentionResponse,
  AnalyticsRtoRiskResponse,
  AnalyticsOrderStatusMixResponse,
  AnalyticsContributionMarginResponse,
  AnalyticsCostInputsResponse,
  CostInputDto,
  AnalyticsTopProductsResponse,
  AnalyticsOrdersListResponse,
  AnalyticsProductDetailResponse,
  AnalyticsProductAffinityResponse,
  AnalyticsProductCategoriesResponse,
  AnalyticsJourneyFirstTouchMixResponse,
  AnalyticsShipmentOutcomesResponse,
  AnalyticsRecordsResponse,
  RecordEntity,
  AnalyticsReturnFunnelResponse,
  AnalyticsBehaviorOverviewResponse,
  AnalyticsFunnelResponse,
  AnalyticsFunnelUsersResponse,
  AnalyticsAbandonedCartResponse,
  AnalyticsEngagementResponse,
  AnalyticsSearchBehaviorResponse,
  AnalyticsFormConversionResponse,
  AnalyticsJourneyStitchRateResponse,
  AnalyticsJourneyTimelineResponse,
  AnalyticsJourneyEventsResponse,
  AnalyticsJourneyPathsResponse,
  AnalyticsJourneyListResponse,
  AnalyticsRepeatLatencyResponse,
  AnalyticsCohortUsersResponse,
  AnalyticsDeliveryTimeResponse,
  AnalyticsCodRtoResponse,
  AnalyticsUtmSourceResponse,
  AnalyticsCampaignAttributionResponse,
  AnalyticsCampaignTimeseriesResponse,
  AnalyticsAttributedRevenueTimeseriesResponse,
  AttributionModel,
  AnalyticsAttributionByChannelResponse,
  AnalyticsAttributionReconciliationResponse,
  AnalyticsChannelRoasResponse,
} from '../types';
import { bffFetch, generateRequestId, parseData, type BffEnvelope } from './core';

// ── Analytics (Phase 1) ────────────────────────────────────────────────────────
// All routes: BFF-only, session-authed. Brand from session (D-1).
// Unwrap { request_id, data } envelope same pattern as dashboardApi.

export const analyticsApi = {
  /**
   * GET /api/v1/analytics/revenue-timeseries
   * Returns per-bucket realized + provisional revenue.
   */
  getRevenueTimeseries: async (params?: {
    from?: string;
    to?: string;
    grain?: 'day' | 'week';
  }): Promise<AnalyticsTimeseriesResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.grain) qs.set('grain', params.grain);
    const qsStr = qs.toString();
    const { data } = await bffFetch<BffEnvelope<AnalyticsTimeseriesResponse>>(
      `/v1/analytics/revenue-timeseries${qsStr ? `?${qsStr}` : ''}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/kpi-summary
   * Returns brand KPI snapshot.
   */
  getKpiSummary: async (asOf?: string): Promise<AnalyticsKpiSummaryResponse> => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    const { data } = await bffFetch<BffEnvelope<AnalyticsKpiSummaryResponse>>(
      `/v1/analytics/kpi-summary${qs}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/executive-metrics
   * H9 — headline AOV/LTV/repeat_rate/CAC/ROAS over the Gold marts (registry-backed).
   */
  getExecutiveMetrics: async (params?: { from?: string; to?: string }): Promise<AnalyticsExecutiveMetricsResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const { data } = await bffFetch<BffEnvelope<AnalyticsExecutiveMetricsResponse>>(
      `/v1/analytics/executive-metrics${qsStr ? `?${qsStr}` : ''}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/recognition-breakdown
   * Returns recognition state distribution.
   */
  getRecognitionBreakdown: async (asOf?: string): Promise<AnalyticsRecognitionBreakdownResponse> => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    const { data } = await bffFetch<BffEnvelope<AnalyticsRecognitionBreakdownResponse>>(
      `/v1/analytics/recognition-breakdown${qs}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/revenue-monthly
   * Per-month revenue-lifecycle breakdown (gold_revenue_analytics): MoM growth,
   * recognition funnel, net-realized series. Numbers come from the Gold mart.
   */
  getRevenueMonthly: async (): Promise<AnalyticsRevenueMonthlyResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsRevenueMonthlyResponse>>(
      `/v1/analytics/revenue-monthly`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/recent-activity
   * Returns the latest N ledger rows.
   */
  getRecentActivity: async (limit?: number): Promise<AnalyticsRecentActivityResponse> => {
    const qs = limit ? `?limit=${limit}` : '';
    const { data } = await bffFetch<BffEnvelope<AnalyticsRecentActivityResponse>>(
      `/v1/analytics/recent-activity${qs}`,
    );
    return data;
  },

  // ── Phase 2 ────────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/analytics/orders-timeseries
   * Returns per-bucket order count + RTO count + realized revenue.
   */
  getOrdersTimeseries: async (params?: {
    from?: string;
    to?: string;
    grain?: 'day' | 'week';
  }): Promise<AnalyticsOrdersTimeseriesResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.grain) qs.set('grain', params.grain);
    const qsStr = qs.toString();
    const { data } = await bffFetch<BffEnvelope<AnalyticsOrdersTimeseriesResponse>>(
      `/v1/analytics/orders-timeseries${qsStr ? `?${qsStr}` : ''}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/order-stats
   * Returns per-currency order stats: order count, AOV, RTO rate.
   */
  getOrderStats: async (asOf?: string): Promise<AnalyticsOrderStatsResponse> => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    const { data } = await bffFetch<BffEnvelope<AnalyticsOrderStatsResponse>>(
      `/v1/analytics/order-stats${qs}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/data-health
   * Returns ingestion + connector-sync health (bounded read).
   */
  getDataHealth: async (): Promise<AnalyticsDataHealthResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsDataHealthResponse>>(
      `/v1/analytics/data-health`,
    );
    return data;
  },

  /**
   * GET /api/v1/dashboard/data-foundation-health — the readiness verdict (P1).
   * One tier (blocked|building|ready|healthy) + the progression checklist + the next step.
   * Parsed at the seam so a drift in the foundation shape fails loudly.
   */
  getFoundationHealth: async (): Promise<FoundationHealthResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/dashboard/data-foundation-health');
    return parseData(FoundationHealthSchema, env);
  },

  /**
   * GET /api/v1/entitlements — readiness-driven progressive unlock (P2).
   * Server-driven eligibility for gated centers + connector categories. Parsed at the seam.
   */
  getEntitlements: async (): Promise<EntitlementsResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/entitlements');
    return parseData(EntitlementsSchema, env);
  },

  /**
   * GET /api/v1/data-quality/summary
   * Returns per-category × per-target dq grades, freshness-SLA status, dq_grade
   * coverage, effective_confidence, and the trust-gate decision (metric-engine read).
   * The UI NEVER queries dq_check_result — this BFF route is the sole read path (I-ST01).
   * D-10: unwrap { request_id, data } → DataQualitySummaryResponse; preserve no_data.
   */
  getDataQualitySummary: async (): Promise<DataQualitySummaryResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/data-quality/summary`,
    );
    return parseData(DataQualitySummarySchema, env);
  },

  /**
   * GET /api/v1/data-quality/medallion-journey — the Data Journey observability roll-up.
   * One payload tracing the brand's data through the pipeline stages
   * Bronze → Silver → Identity → Gold → Serving (row counts, freshness, per-stage state).
   * BFF-only, brand-scoped from session (D-1). D-10: unwrap { request_id, data }.
   *
   * NOTE: no zod schema at the seam yet — the endpoint is being built in parallel; typed against
   * the shared MedallionJourney contract. Swap to parseData(MedallionJourneySchema, env) once the
   * contract package publishes the schema, mirroring getDataQualitySummary.
   */
  getMedallionJourney: async (): Promise<MedallionJourney> => {
    const { data } = await bffFetch<BffEnvelope<MedallionJourney>>(
      `/v1/data-quality/medallion-journey`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/settlements — Razorpay net-of-fees settlement summary.
   * D-10: unwrap { request_id, data } → AnalyticsSettlementsResponse.
   * state:'no_data' is preserved (never coerced to has_data with zeros).
   */
  getSettlements: async (asOf?: string): Promise<AnalyticsSettlementsResponse> => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    const { data } = await bffFetch<BffEnvelope<AnalyticsSettlementsResponse>>(
      `/v1/analytics/settlements${qs}`,
    );
    return data;
  },

  // ── Ad-connectors (Slice 1 Track 3) — spend + blended ROAS ────────────────────

  /**
   * GET /api/v1/analytics/ad-spend-timeseries
   * Returns per-bucket ad spend grouped by (platform, currency_code).
   * Amounts are bigint-serialized minor-unit strings (never floats).
   */
  getAdSpendTimeseries: async (params?: {
    from?: string;
    to?: string;
    grain?: 'day' | 'week';
    platform?: 'meta' | 'google_ads';
  }): Promise<AnalyticsAdSpendTimeseriesResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.grain) qs.set('grain', params.grain);
    if (params?.platform) qs.set('platform', params.platform);
    const qsStr = qs.toString();
    const { data } = await bffFetch<BffEnvelope<AnalyticsAdSpendTimeseriesResponse>>(
      `/v1/analytics/ad-spend-timeseries${qsStr ? `?${qsStr}` : ''}`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/blended-roas
   * Returns per-currency blended ROAS (realized ÷ spend), same-currency only.
   * roas_ratio is an exact decimal string or null (spend=0 → honest null).
   */
  getBlendedRoas: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsBlendedRoasResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const { data } = await bffFetch<BffEnvelope<AnalyticsBlendedRoasResponse>>(
      `/v1/analytics/blended-roas${qsStr ? `?${qsStr}` : ''}`,
    );
    return data;
  },

  // ── Tracking Center (Phase 1 Track C) ────────────────────────────────────────

  /**
   * GET /api/v1/analytics/tracking-health
   * Returns pixel-collection health (first-event, volume, freshness, consent counts).
   */
  getTrackingHealth: async (): Promise<AnalyticsTrackingHealthResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsTrackingHealthResponse>>(
      `/v1/analytics/tracking-health`,
    );
    return data;
  },

  /**
   * GET /api/v1/analytics/recent-events
   * Returns the latest N collected events (type/time/anonymized ids) for the Explorer.
   */
  getRecentEvents: async (limit?: number): Promise<AnalyticsRecentEventsResponse> => {
    const qs = limit ? `?limit=${limit}` : '';
    const { data } = await bffFetch<BffEnvelope<AnalyticsRecentEventsResponse>>(
      `/v1/analytics/recent-events${qs}`,
    );
    return data;
  },

  // ── CoD / RTO surface (GoKwik + Shopflo Track C) ──────────────────────────────
  // D-10: unwrap { request_id, data }. state:'no_data' preserved (honest, never zeros).
  // data_source passes through for the Synthetic (dev) badge.

  /** GET /api/v1/analytics/cod-rto-rates — RTO% by pincode cohort (GoKwik AWB terminal states). */
  getCodRtoRates: async (): Promise<AnalyticsCodRtoRatesResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsCodRtoRatesResponse>>(
      `/v1/analytics/cod-rto-rates`,
    );
    return data;
  },

  /** GET /api/v1/analytics/cod-mix — CoD CM2 + CoD-vs-prepaid mix (ledger cod_* events). */
  getCodMix: async (): Promise<AnalyticsCodMixResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsCodMixResponse>>(
      `/v1/analytics/cod-mix`,
    );
    return data;
  },

  /** GET /api/v1/analytics/cod-rto — the COD/RTO outcome funnel per currency (gold_cod_rto, DR-006). */
  getCodRto: async (): Promise<AnalyticsCodRtoResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(`/v1/analytics/cod-rto`);
    return parseData(CodRtoSchema, env);
  },

  /**
   * GET /api/v1/analytics/cohort-retention
   * H9/H11 acquisition-cohort curve (size, lifetime orders/value, orders-per-customer) over the
   * order spine, from gold_cohorts via the metric registry. Honest no_data on zero cohorts.
   */
  getCohortRetention: async (): Promise<AnalyticsCohortRetentionResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsCohortRetentionResponse>>(
      `/v1/analytics/cohort-retention`,
    );
    return data;
  },

  /** GET /api/v1/analytics/retention/repeat-latency — time-to-2nd-purchase median + histogram (#32b). */
  getRepeatLatency: async (): Promise<AnalyticsRepeatLatencyResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(`/v1/analytics/retention/repeat-latency`);
    return parseData(RepeatLatencySchema, env);
  },

  /**
   * GET /api/v1/analytics/retention/cohort-users — paginated customers inside one cohort cell
   * (cohort_month × period), LTV-enriched from gold_customer_360 where available. Parsed at the seam.
   */
  getCohortUsers: async (params: {
    cohortMonth: string;
    period: number;
    page?: number;
    pageSize?: number;
  }): Promise<AnalyticsCohortUsersResponse> => {
    const qs = new URLSearchParams();
    qs.set('cohort_month', params.cohortMonth);
    qs.set('period', String(params.period));
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('page_size', String(params.pageSize));
    const env = await bffFetch<BffEnvelope<unknown>>(`/v1/analytics/retention/cohort-users?${qs.toString()}`);
    return parseData(CohortUsersSchema, env);
  },

  /** GET /api/v1/analytics/operations/delivery-time — per-courier avg delivery days + day histogram (P3). */
  getDeliveryTime: async (): Promise<AnalyticsDeliveryTimeResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(`/v1/analytics/operations/delivery-time`);
    return parseData(DeliveryTimeSchema, env);
  },

  /** GET /api/v1/analytics/utm-source — the UTM / acquisition-source matrix (visitors/conv/revenue/ltv/repeat) (P3). */
  getUtmSource: async (): Promise<AnalyticsUtmSourceResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(`/v1/analytics/utm-source`);
    return parseData(UtmSourceSchema, env);
  },

  /** GET /api/v1/analytics/checkout-funnel — abandoned-checkout funnel (Shopflo, REAL). */
  getCheckoutFunnel: async (): Promise<AnalyticsCheckoutFunnelResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsCheckoutFunnelResponse>>(
      `/v1/analytics/checkout-funnel`,
    );
    return data;
  },

  /** GET /api/v1/analytics/rto-risk-distribution — per-order RTO risk (GoKwik RTO-Predict). */
  getRtoRiskDistribution: async (): Promise<AnalyticsRtoRiskResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsRtoRiskResponse>>(
      `/v1/analytics/rto-risk-distribution`,
    );
    return data;
  },

  // ── Order-status mix (Silver tier — feat-silver-tier-order-state) ─────────────
  // The FIRST read from the Silver analytics tier (silver.order_state), via the
  // metric-engine Silver seam (I-ST01 — UI never queries StarRocks). D-10: unwrap
  // { request_id, data }; state:'no_data' preserved (honest, never zeros).

  /** GET /api/v1/analytics/order-status-mix — counts + share by order lifecycle state. */
  getOrderStatusMix: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsOrderStatusMixResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/order-status-mix${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(OrderStatusMixSchema, env);
  },

  /**
   * GET /api/v1/analytics/top-products
   * Per-SKU rollup (units / line GMV / order count) over the Silver order-line mart
   * (feat-shopify-order-depth). Parsed at the seam; state:'no_data' preserved.
   */
  getTopProducts: async (params?: { from?: string; to?: string; limit?: number }): Promise<AnalyticsTopProductsResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.limit) qs.set('limit', String(params.limit));
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/top-products${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(TopProductsSchema, env);
  },

  /**
   * GET /api/v1/analytics/orders-list
   * Paginated latest-state orders from Bronze (feat-shopify-order-depth). Parsed at the seam.
   */
  getOrdersList: async (params?: { page?: number; pageSize?: number }): Promise<AnalyticsOrdersListResponse> => {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('page_size', String(params.pageSize));
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/orders-list${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(OrdersListSchema, env);
  },

  /** GET /v1/analytics/contribution-margin — CM1/CM2 + cost_confidence (feat-cm2-cost-inputs). */
  getContributionMargin: async (asOf?: string): Promise<AnalyticsContributionMarginResponse> => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    const env = await bffFetch<BffEnvelope<unknown>>(`/v1/analytics/contribution-margin${qs}`);
    return parseData(ContributionMarginSchema, env);
  },

  /** GET /v1/costs — the brand's active cost inputs. */
  getCostInputs: async (): Promise<AnalyticsCostInputsResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/costs');
    return parseData(CostInputsListSchema, env);
  },

  /** POST /v1/costs — upsert one cost input (COGS/shipping/fee rate or fixed amount). */
  upsertCostInput: async (body: {
    scope: CostInputDto['scope'];
    scope_ref?: string;
    cost_type: CostInputDto['cost_type'];
    amount_minor?: string;
    pct_bps?: number;
    currency_code: string;
    cost_confidence?: CostInputDto['cost_confidence'];
  }): Promise<{ cost_input_id: string }> => {
    const { data } = await bffFetch<BffEnvelope<{ cost_input_id: string }>>('/v1/costs', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    return data;
  },

  /**
   * GET /api/v1/analytics/products/:productId
   * A single product's storefront funnel (views→atc→purchases→revenue) + returns + conversion rates
   * from gold_product_detail (P3). Parsed at the seam; state:'not_found' preserved.
   */
  getProductDetail: async (productId: string): Promise<AnalyticsProductDetailResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/products/${encodeURIComponent(productId)}`,
    );
    return parseData(ProductDetailSchema, env);
  },

  /**
   * GET /api/v1/analytics/products/:productId/affinity?limit=N
   * Frequently-bought-together partners for a product from gold_product_affinity (P3). NO money.
   */
  getProductAffinity: async (
    productId: string,
    params?: { limit?: number },
  ): Promise<AnalyticsProductAffinityResponse> => {
    const qs = params?.limit ? `?limit=${params.limit}` : '';
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/products/${encodeURIComponent(productId)}/affinity${qs}`,
    );
    return parseData(ProductAffinitySchema, env);
  },

  /**
   * GET /api/v1/analytics/products/categories?limit=N
   * Product revenue treemap (leaf = product, size = revenue_minor) from gold_product_detail (P3).
   */
  getProductCategories: async (params?: { limit?: number }): Promise<AnalyticsProductCategoriesResponse> => {
    const qs = params?.limit ? `?limit=${params.limit}` : '';
    const env = await bffFetch<BffEnvelope<unknown>>(`/v1/analytics/products/categories${qs}`);
    return parseData(ProductCategoriesSchema, env);
  },

  // ── Journey / first-touch (Silver tier — feat-journey-touchpoint) ─────────────
  // The SECOND read from the Silver analytics tier (silver.touchpoint), via the
  // metric-engine journey seam (withSilverBrand, I-ST01 — UI never queries StarRocks).
  // D-10: unwrap { request_id, data }; state:'no_data' preserved (honest, never zeros).
  // data_source passes through for the Synthetic (dev) badge.

  /** GET /api/v1/analytics/journey/first-touch-mix — first-touch channel mix over a range. */
  getJourneyFirstTouchMix: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsJourneyFirstTouchMixResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/journey/first-touch-mix${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(JourneyFirstTouchMixSchema, env);
  },

  /** GET /api/v1/analytics/journey/paths — aggregate journey-path Sankey (#32a): top-N channel paths + edges. */
  getJourneyPaths: async (params?: {
    limit?: number;
  }): Promise<AnalyticsJourneyPathsResponse> => {
    const qs = new URLSearchParams();
    if (params?.limit != null) qs.set('limit', String(params.limit));
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/journey/paths${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(JourneyPathsSchema, env);
  },

  /** GET /api/v1/analytics/journey/list — paginated recent customer journeys (keyset next_cursor). */
  getJourneyList: async (params?: {
    limit?: number;
    cursor?: string | null;
  }): Promise<AnalyticsJourneyListResponse> => {
    const qs = new URLSearchParams();
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.cursor) qs.set('cursor', params.cursor);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/journey/list${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(JourneyListSchema, env);
  },

  /** GET /api/v1/analytics/logistics/shipment-outcomes — delivered/RTO + RTO% by courier/pincode. */
  getShipmentOutcomes: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsShipmentOutcomesResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/logistics/shipment-outcomes${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(ShipmentOutcomesSchema, env);
  },

  /** GET /api/v1/analytics/logistics/return-funnel — return_class breakdown + completion% (SR-10). */
  getReturnFunnel: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsReturnFunnelResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/logistics/return-funnel${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(ReturnFunnelSchema, env);
  },

  /** GET /api/v1/analytics/behavior/overview — storefront browse/search/view over a range. */
  getBehaviorOverview: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsBehaviorOverviewResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/behavior/overview${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(BehaviorOverviewSchema, env);
  },

  /** GET /api/v1/analytics/funnel — storefront conversion funnel (sessions→product→cart→purchase). */
  getFunnelAnalytics: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsFunnelResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/funnel${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(FunnelAnalyticsSchema, env);
  },

  /** GET /api/v1/analytics/funnel/users — paginated visitors who DROPPED at a funnel step (gold_funnel_user). */
  getFunnelUsers: async (params: {
    step: 'session' | 'product_view' | 'cart' | 'checkout' | 'purchase';
    date_start?: string;
    date_end?: string;
    page?: number;
    page_size?: number;
  }): Promise<AnalyticsFunnelUsersResponse> => {
    const qs = new URLSearchParams();
    qs.set('step', params.step);
    if (params.date_start) qs.set('date_start', params.date_start);
    if (params.date_end) qs.set('date_end', params.date_end);
    if (params.page != null) qs.set('page', String(params.page));
    if (params.page_size != null) qs.set('page_size', String(params.page_size));
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/funnel/users?${qs.toString()}`,
    );
    return parseData(FunnelUsersSchema, env);
  },

  /** GET /api/v1/analytics/abandoned-cart — cart sessions converted vs abandoned + recovery rate. */
  getAbandonedCart: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsAbandonedCartResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/abandoned-cart${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(AbandonedCartSchema, env);
  },

  /** GET /api/v1/analytics/engagement — engaged (multi-touch) vs bounce sessions + avg touches. */
  getEngagement: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsEngagementResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/engagement${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(EngagementSchema, env);
  },

  /** GET /api/v1/analytics/search — on-site search volume + reach (page_type='search' of gold_behavior). */
  getSearchBehavior: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsSearchBehaviorResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/search${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(SearchBehaviorSchema, env);
  },

  /** GET /api/v1/analytics/forms — lead-form submission counts/rates (gold_conversion_feedback). */
  getFormConversion: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsFormConversionResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/forms${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(FormConversionSchema, env);
  },

  /**
   * GET /api/v1/analytics/records/:entity — one page (20, newest-first) of canonical connector
   * records (orders | shipments | ad_spend), with date-range + free-text search. Returns column
   * metadata + stringified rows + total (for pagination).
   */
  getRecords: async (
    entity: RecordEntity,
    params?: { from?: string; to?: string; search?: string; page?: number },
  ): Promise<AnalyticsRecordsResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.search) qs.set('search', params.search);
    if (params?.page && params.page > 1) qs.set('page', String(params.page));
    const qsStr = qs.toString();
    const { data } = await bffFetch<BffEnvelope<AnalyticsRecordsResponse>>(
      `/v1/analytics/records/${entity}${qsStr ? `?${qsStr}` : ''}`,
    );
    return data;
  },

  /** GET /api/v1/analytics/journey/stitch-rate — deterministic cart-stitch hit-rate. */
  getJourneyStitchRate: async (params?: {
    from?: string;
    to?: string;
  }): Promise<AnalyticsJourneyStitchRateResponse> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const qsStr = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/journey/stitch-rate${qsStr ? `?${qsStr}` : ''}`,
    );
    return parseData(JourneyStitchRateSchema, env);
  },

  /** GET /api/v1/analytics/journey/timeline?orderId= — ordered touchpoints for one order. */
  getJourneyTimeline: async (params: {
    orderId: string;
  }): Promise<AnalyticsJourneyTimelineResponse> => {
    const qs = new URLSearchParams();
    qs.set('orderId', params.orderId);
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/journey/timeline?${qs.toString()}`,
    );
    return parseData(JourneyTimelineSchema, env);
  },

  /**
   * GET /api/v1/analytics/journey/events?brainId= — the versioned journey LEDGER for one
   * resolved customer (mv_journey_events_current), newest-first, keyset-paginated
   * (opaque next_cursor). Money = bigint minor string + sibling currency (composite rows only).
   */
  getJourneyEvents: async (params: {
    brainId: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<AnalyticsJourneyEventsResponse> => {
    const qs = new URLSearchParams();
    qs.set('brainId', params.brainId);
    if (params.cursor) qs.set('cursor', params.cursor);
    if (params.limit != null) qs.set('limit', String(params.limit));
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/journey/events?${qs.toString()}`,
    );
    return parseData(JourneyEventsLedgerSchema, env);
  },

  // ── Attribution (Phase 5 — feat-attribution-ledger Track C) ───────────────────
  // The attributed-revenue / channel-ROAS surface. Reads the Gold attribution credit
  // ledger via the metric-engine sole read path (I-ST01 — the UI NEVER queries the
  // ledger/StarRocks). D-10: unwrap { request_id, data }; state:'no_data' preserved
  // (honest, never zeros). data_source passes through for the Synthetic (dev) badge.
  // Money fields are SIGNED bigint-serialized minor-unit strings (I-S07) — never floats.

  /** GET /api/v1/analytics/attribution/by-channel — attributed revenue by channel for a model. */
  getAttributionByChannel: async (params: {
    model: AttributionModel;
    from?: string;
    to?: string;
  }): Promise<AnalyticsAttributionByChannelResponse> => {
    const qs = new URLSearchParams();
    qs.set('model', params.model);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/attribution/by-channel?${qs.toString()}`,
    );
    return parseData(AttributionByChannelSchema, env);
  },

  /** GET /api/v1/analytics/attribution/reconciliation — the closed-sum residual (oracle made visible). */
  getAttributionReconciliation: async (params: {
    model: AttributionModel;
    from?: string;
    to?: string;
  }): Promise<AnalyticsAttributionReconciliationResponse> => {
    const qs = new URLSearchParams();
    qs.set('model', params.model);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/attribution/reconciliation?${qs.toString()}`,
    );
    return parseData(AttributionReconciliationSchema, env);
  },

  /** GET /api/v1/analytics/attribution/channel-roas — per-channel attributed ÷ ad spend. */
  getChannelRoas: async (params: {
    model: AttributionModel;
    from?: string;
    to?: string;
  }): Promise<AnalyticsChannelRoasResponse> => {
    const qs = new URLSearchParams();
    qs.set('model', params.model);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/attribution/channel-roas?${qs.toString()}`,
    );
    return parseData(ChannelRoasSchema, env);
  },

  /** GET /api/v1/analytics/attribution/campaign-attribution — per-campaign attributed revenue + ROAS (#32c). */
  getCampaignAttribution: async (params: {
    model: AttributionModel;
  }): Promise<AnalyticsCampaignAttributionResponse> => {
    const qs = new URLSearchParams();
    qs.set('model', params.model);
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/attribution/campaign-attribution?${qs.toString()}`,
    );
    return parseData(CampaignAttributionSchema, env);
  },

  /** GET /api/v1/analytics/attribution/campaign-timeseries — date-bucketed per-campaign/channel attributed revenue (#32c-ts). */
  getCampaignTimeseries: async (params: {
    model: AttributionModel;
    date_start?: string;
    date_end?: string;
  }): Promise<AnalyticsCampaignTimeseriesResponse> => {
    const qs = new URLSearchParams();
    qs.set('model', params.model);
    if (params.date_start) qs.set('date_start', params.date_start);
    if (params.date_end) qs.set('date_end', params.date_end);
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/attribution/campaign-timeseries?${qs.toString()}`,
    );
    return parseData(CampaignTimeseriesSchema, env);
  },

  /** GET /api/v1/analytics/attribution/revenue-timeseries — date × channel attributed revenue (P3). */
  getAttributedRevenueTimeseries: async (params: {
    model: AttributionModel;
    date_start?: string;
    date_end?: string;
  }): Promise<AnalyticsAttributedRevenueTimeseriesResponse> => {
    const qs = new URLSearchParams();
    qs.set('model', params.model);
    if (params.date_start) qs.set('date_start', params.date_start);
    if (params.date_end) qs.set('date_end', params.date_end);
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/analytics/attribution/revenue-timeseries?${qs.toString()}`,
    );
    return parseData(AttributedRevenueTimeseriesSchema, env);
  },
};
