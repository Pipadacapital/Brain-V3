'use client';

/**
 * Analytics hooks — react-query bindings for the Phase 1 analytics BFF endpoints.
 *
 * Query keys are prefixed with 'analytics' so they auto-invalidate on brand switch
 * when brand-switcher.tsx calls queryClient.invalidateQueries({ queryKey: ['analytics'] }).
 * The DASHBOARD_QUERY_KEY is also invalidated separately — these are siblings.
 *
 * staleTime: timeseries + kpi = 5 min (heavy reads); activity = 1 min (event feed).
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { analyticsApi, insightsApi } from '@/lib/api/client';
import type { AttributionModel } from '@/lib/api/types';

export const ANALYTICS_QUERY_KEY = ['analytics'] as const;

/**
 * AI Copilot daily briefing — the deterministic insight/opportunity/risk feed over the Gold marts.
 * Lives under the analytics query key so it auto-invalidates on brand switch; refreshes live.
 */
export function useInsightsBriefing() {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'insights-briefing'],
    queryFn: () => insightsApi.getBriefing(),
    staleTime: 5 * 60_000,
    refetchInterval: 60_000,
  });
}

/**
 * useRevenueTimeseries — fetches per-bucket realized + provisional revenue.
 * @param params - Date range + grain. Defaults: last 90 days, day grain.
 */
export function useRevenueTimeseries(params?: {
  from?: string;
  to?: string;
  grain?: 'day' | 'week';
}) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'revenue-timeseries', params?.from, params?.to, params?.grain ?? 'day'],
    queryFn: () => analyticsApi.getRevenueTimeseries(params),
    staleTime: 5 * 60_000, // 5 minutes
    // feat-realtime-ingestion-pipeline (Track C): live-refresh so newly-ingested revenue
    // buckets appear within one scheduler interval without a manual reload (same BFF read).
    refetchInterval: 30_000,
  });
}

/**
 * useKpiSummary — fetches brand KPI snapshot as of a date.
 * @param asOf - YYYY-MM-DD date (optional; server defaults to today).
 */
export function useKpiSummary(asOf?: string) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'kpi-summary', asOf ?? 'today'],
    queryFn: () => analyticsApi.getKpiSummary(asOf),
    staleTime: 5 * 60_000,
    // feat-realtime-ingestion-pipeline (Track C): live-refresh the headline KPI tiles
    // (realized / provisional / orders / AOV / RTO) without a manual reload.
    refetchInterval: 30_000,
  });
}

/**
 * useExecutiveMetrics — H9 headline AOV/LTV/repeat_rate/CAC/ROAS over the Gold marts.
 */
export function useExecutiveMetrics(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'executive-metrics', params?.from ?? 'd', params?.to ?? 'd'],
    queryFn: () => analyticsApi.getExecutiveMetrics(params),
    staleTime: 5 * 60_000,
    refetchInterval: 60_000,
  });
}

/**
 * useCohortRetention — H9/H11 acquisition-cohort curve (size, lifetime orders/value,
 * orders-per-customer) from gold_cohorts via /v1/analytics/cohort-retention. Powers the
 * Retention tab. No params (whole-history cohorts); honest no_data when the brand has none.
 */
export function useCohortRetention() {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'cohort-retention'],
    queryFn: () => analyticsApi.getCohortRetention(),
    staleTime: 5 * 60_000,
    refetchInterval: 60_000,
  });
}

/**
 * useRecognitionBreakdown — fetches recognition state distribution.
 * @param asOf - YYYY-MM-DD date (optional; server defaults to today).
 */
export function useRecognitionBreakdown(asOf?: string) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'recognition-breakdown', asOf ?? 'today'],
    queryFn: () => analyticsApi.getRecognitionBreakdown(asOf),
    staleTime: 5 * 60_000,
  });
}

/**
 * useRevenueMonthly — per-month revenue-lifecycle breakdown from the Gold monthly
 * mart (gold_revenue_analytics). Drives MoM growth, recognition funnel, net-realized.
 */
export function useRevenueMonthly() {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'revenue-monthly'],
    queryFn: () => analyticsApi.getRevenueMonthly(),
    staleTime: 5 * 60_000,
    refetchInterval: 60_000,
  });
}

/**
 * useRecentActivity — fetches the latest N ledger rows.
 * @param limit - Max rows (default 20).
 */
export function useRecentActivity(limit = 20) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'recent-activity', limit],
    queryFn: () => analyticsApi.getRecentActivity(limit),
    staleTime: 60_000, // 1 minute — event feed refreshes more often
    // feat-realtime-ingestion-pipeline (Track C): the activity feed is the most live
    // surface — tightened to 20s so new ledger rows appear quickly after ingestion.
    refetchInterval: 20_000,
  });
}

// ── Phase 2 ──────────────────────────────────────────────────────────────────
// Query keys share the 'analytics' prefix → auto-invalidate on brand switch
// (brand-switcher.tsx invalidates queryKey: ['analytics']).

/**
 * useOrdersTimeseries — fetches per-bucket order count + RTO count + realized revenue.
 * @param params - Date range + grain. Defaults: last 90 days, day grain (server-side).
 */
export function useOrdersTimeseries(params?: {
  from?: string;
  to?: string;
  grain?: 'day' | 'week';
}) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'orders-timeseries', params?.from, params?.to, params?.grain ?? 'day'],
    queryFn: () => analyticsApi.getOrdersTimeseries(params),
    staleTime: 5 * 60_000, // 5 minutes
    // feat-realtime-ingestion-pipeline (Track C): live-refresh order/RTO buckets.
    refetchInterval: 30_000,
  });
}

/**
 * useOrderStats — fetches per-currency order stats snapshot as of a date.
 * @param asOf - YYYY-MM-DD date (optional; server defaults to today).
 */
export function useOrderStats(asOf?: string) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'order-stats', asOf ?? 'today'],
    queryFn: () => analyticsApi.getOrderStats(asOf),
    staleTime: 5 * 60_000,
    // feat-realtime-ingestion-pipeline (Track C): live-refresh the per-currency order stats.
    refetchInterval: 30_000,
  });
}

/**
 * useOrdersList — paginated latest-state orders from Bronze (feat-shopify-order-depth).
 * Keeps the previous page's data while the next loads, for flicker-free pagination.
 */
export function useOrdersList(page: number, pageSize = 20) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'orders-list', page, pageSize],
    queryFn: () => analyticsApi.getOrdersList({ page, pageSize }),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

/**
 * useContributionMargin — CM1/CM2 + cost_confidence (feat-cm2-cost-inputs).
 */
export function useContributionMargin(asOf?: string) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'contribution-margin', asOf ?? 'today'],
    queryFn: () => analyticsApi.getContributionMargin(asOf),
    staleTime: 5 * 60_000,
  });
}

/** useCostInputs — the brand's active cost structure. */
export function useCostInputs() {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'cost-inputs'],
    queryFn: () => analyticsApi.getCostInputs(),
    staleTime: 5 * 60_000,
  });
}

/** useUpsertCostInput — save a cost input; invalidates margin + cost reads on success. */
export function useUpsertCostInput() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: analyticsApi.upsertCostInput,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...ANALYTICS_QUERY_KEY, 'cost-inputs'] });
      void qc.invalidateQueries({ queryKey: [...ANALYTICS_QUERY_KEY, 'contribution-margin'] });
    },
  });
}

/**
 * useTopProducts — per-SKU rollup (units / line GMV / order count) over the Silver order-line
 * mart (feat-shopify-order-depth). Window defaults to last 90 days server-side.
 */
export function useTopProducts(params?: { from?: string; to?: string; limit?: number }) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'top-products', params?.from, params?.to, params?.limit ?? 10],
    queryFn: () => analyticsApi.getTopProducts(params),
    staleTime: 5 * 60_000,
  });
}

/**
 * useOrderDetail — a single order's economic breakdown from Bronze (feat-shopify-order-depth).
 * @param orderId - the order natural key; the query is disabled when falsy.
 */
export function useOrderDetail(orderId: string | null | undefined) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'order-detail', orderId ?? ''],
    queryFn: () => analyticsApi.getOrderDetail(orderId as string),
    enabled: !!orderId,
    staleTime: 60_000,
  });
}

// ── Ad-connectors (Slice 1 Track 3) — spend + blended ROAS ──────────────────────
// Query keys share the 'analytics' prefix → auto-invalidate on brand switch.

/**
 * useAdSpendTimeseries — fetches per-bucket ad spend (platform, currency).
 * @param params - Date range + grain + optional platform filter. Defaults: last 35 days, day grain (server-side).
 */
export function useAdSpendTimeseries(params?: {
  from?: string;
  to?: string;
  grain?: 'day' | 'week';
  platform?: 'meta' | 'google_ads';
}) {
  return useQuery({
    queryKey: [
      ...ANALYTICS_QUERY_KEY,
      'ad-spend-timeseries',
      params?.from,
      params?.to,
      params?.grain ?? 'day',
      params?.platform ?? 'all',
    ],
    queryFn: () => analyticsApi.getAdSpendTimeseries(params),
    staleTime: 5 * 60_000, // 5 minutes
  });
}

/**
 * useBlendedRoas — fetches per-currency blended ROAS (realized ÷ spend) over a window.
 * @param params - Date range. Defaults: last 35 days (server-side).
 */
export function useBlendedRoas(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'blended-roas', params?.from, params?.to],
    queryFn: () => analyticsApi.getBlendedRoas(params),
    staleTime: 5 * 60_000,
  });
}

/**
 * useDataHealth — fetches ingestion + connector-sync health.
 * staleTime 1 min; refetches on the same cadence as the event feed.
 */
export function useDataHealth() {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'data-health'],
    queryFn: () => analyticsApi.getDataHealth(),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

/**
 * useDataQualitySummary — fetches the Phase-7 DQ summary (grades, freshness-SLA,
 * coverage, effective_confidence, trust gate). Shares the 'analytics' query-key
 * prefix → auto-invalidates on brand switch. BFF/metric-engine read only.
 */
export function useDataQualitySummary() {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'data-quality-summary'],
    queryFn: () => analyticsApi.getDataQualitySummary(),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

/**
 * useSettlements — fetches the Razorpay net-of-fees settlement summary as of a date.
 * Shares the 'analytics' query-key prefix → auto-invalidates on brand switch.
 * @param asOf - YYYY-MM-DD date (optional; server defaults to today).
 */
export function useSettlements(asOf?: string) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'settlements', asOf ?? 'today'],
    queryFn: () => analyticsApi.getSettlements(asOf),
    staleTime: 5 * 60_000,
  });
}

// ── CoD / RTO surface (GoKwik + Shopflo Track C) ─────────────────────────────────
// All share the 'analytics' query-key prefix → auto-invalidate on brand switch.

/** useCodRtoRates — RTO% by pincode cohort (GoKwik AWB terminal states; synthetic in dev). */
export function useCodRtoRates() {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'cod-rto-rates'],
    queryFn: () => analyticsApi.getCodRtoRates(),
    staleTime: 5 * 60_000,
  });
}

/** useCodMix — CoD CM2 + CoD-vs-prepaid mix (ledger cod_* events). */
export function useCodMix() {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'cod-mix'],
    queryFn: () => analyticsApi.getCodMix(),
    staleTime: 5 * 60_000,
  });
}

/** useCheckoutFunnel — Shopflo abandoned-checkout funnel (REAL self-serve webhook). */
export function useCheckoutFunnel() {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'checkout-funnel'],
    queryFn: () => analyticsApi.getCheckoutFunnel(),
    staleTime: 5 * 60_000,
  });
}

/** useRtoRiskDistribution — per-order RTO risk (GoKwik RTO-Predict, latest prediction per order). */
export function useRtoRiskDistribution() {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'rto-risk-distribution'],
    queryFn: () => analyticsApi.getRtoRiskDistribution(),
    staleTime: 5 * 60_000,
  });
}

// ── Order-status mix (Silver tier — feat-silver-tier-order-state) ───────────────
// The FIRST surface read from the Silver analytics tier (silver.order_state) via the
// metric-engine Silver seam (I-ST01 — UI never queries StarRocks). Shares the
// 'analytics' query-key prefix → auto-invalidates on brand switch.

/**
 * useOrderStatusMix — counts + share by order lifecycle state over a date range.
 * @param params - Date range (YYYY-MM-DD). Defaults applied by the caller.
 */
export function useOrderStatusMix(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'order-status-mix', params?.from, params?.to],
    queryFn: () => analyticsApi.getOrderStatusMix(params),
    staleTime: 5 * 60_000,
  });
}

// ── Journey / first-touch (Silver tier — feat-journey-touchpoint) ───────────────
// The SECOND surface read from the Silver analytics tier (silver.touchpoint) via the
// metric-engine journey seam (withSilverBrand, I-ST01 — UI never queries StarRocks).
// Shares the 'analytics' query-key prefix → auto-invalidates on brand switch.

/**
 * useJourneyFirstTouchMix — first-touch channel mix (count + share) over a date range.
 * @param params - Date range (YYYY-MM-DD). Defaults applied by the caller.
 */
export function useJourneyFirstTouchMix(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'journey-first-touch-mix', params?.from, params?.to],
    queryFn: () => analyticsApi.getJourneyFirstTouchMix(params),
    staleTime: 5 * 60_000,
  });
}

/**
 * useJourneyStitchRate — deterministic cart-stitch hit-rate over a date range.
 * @param params - Date range (YYYY-MM-DD). Defaults applied by the caller.
 */
export function useJourneyStitchRate(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'journey-stitch-rate', params?.from, params?.to],
    queryFn: () => analyticsApi.getJourneyStitchRate(params),
    staleTime: 5 * 60_000,
  });
}

/**
 * useJourneyTimeline — ordered touchpoints for one selected order.
 * Disabled until an orderId is provided (no fabricated empty query).
 * @param orderId - The order to resolve a journey timeline for (or null/undefined to skip).
 */
export function useJourneyTimeline(orderId?: string | null) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'journey-timeline', orderId ?? null],
    queryFn: () => analyticsApi.getJourneyTimeline({ orderId: orderId as string }),
    enabled: Boolean(orderId && orderId.trim().length > 0),
    staleTime: 5 * 60_000,
  });
}

/**
 * useShipmentOutcomes — delivered/RTO/other + RTO% (overall, by courier, by pincode) over a range,
 * from the multi-source silver_shipment mart (GoKwik AWB + Shiprocket). Slice 2 (logistics).
 */
export function useShipmentOutcomes(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'shipment-outcomes', params?.from, params?.to],
    queryFn: () => analyticsApi.getShipmentOutcomes(params),
    staleTime: 5 * 60_000,
  });
}

/**
 * useReturnFunnel — return_class breakdown + completion% over a range, from the silver_return mart
 * (SR-4). A SEPARATE dimension from shipment outcomes — returns never carry terminal_class. SR-10.
 */
export function useReturnFunnel(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'return-funnel', params?.from, params?.to],
    queryFn: () => analyticsApi.getReturnFunnel(params),
    staleTime: 5 * 60_000,
  });
}

/**
 * useBehaviorOverview — storefront browse/search/view (sessions/journeys/touches + page-type mix +
 * top viewed products + top searches) over a range, from silver_touchpoint (pixel auto-instr).
 */
export function useBehaviorOverview(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'behavior-overview', params?.from, params?.to],
    queryFn: () => analyticsApi.getBehaviorOverview(params),
    staleTime: 5 * 60_000,
  });
}

/**
 * useFunnelAnalytics — storefront conversion funnel (sessions → product views → cart adds →
 * purchases) over a range, from silver_touchpoint (Phase H pixel). Shares the 'analytics' prefix →
 * auto-invalidates on brand switch.
 */
export function useFunnelAnalytics(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'funnel', params?.from, params?.to],
    queryFn: () => analyticsApi.getFunnelAnalytics(params),
    staleTime: 5 * 60_000,
  });
}

/**
 * useAbandonedCart — cart sessions converted vs abandoned + recovery rate over a range, from
 * silver_touchpoint (Phase H pixel). Shares the 'analytics' prefix → auto-invalidates on brand switch.
 */
export function useAbandonedCart(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'abandoned-cart', params?.from, params?.to],
    queryFn: () => analyticsApi.getAbandonedCart(params),
    staleTime: 5 * 60_000,
  });
}

/**
 * useEngagement — engaged (multi-touch) vs bounce sessions + avg touches over a range, from
 * silver_touchpoint (Phase H pixel). Shares the 'analytics' prefix → auto-invalidates on brand switch.
 */
export function useEngagement(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'engagement', params?.from, params?.to],
    queryFn: () => analyticsApi.getEngagement(params),
    staleTime: 5 * 60_000,
  });
}

// ── Attribution (Phase 5 — feat-attribution-ledger) ──────────────────────────────
// Reads the Gold attribution credit ledger via the metric-engine sole read path
// (I-ST01 — UI never queries the ledger/StarRocks). The `model` is part of the query
// key so the model selector re-fetches without a manual invalidate. Shares the
// 'analytics' prefix → auto-invalidates on brand switch.

/**
 * useAttributionByChannel — attributed revenue by channel for the selected model + window.
 * @param params - Attribution model + date range (YYYY-MM-DD). model is required.
 */
export function useAttributionByChannel(params: {
  model: AttributionModel;
  from?: string;
  to?: string;
}) {
  return useQuery({
    queryKey: [
      ...ANALYTICS_QUERY_KEY,
      'attribution-by-channel',
      params.model,
      params.from,
      params.to,
    ],
    queryFn: () => analyticsApi.getAttributionByChannel(params),
    staleTime: 5 * 60_000,
  });
}

/**
 * useAttributionReconciliation — the closed-sum residual (parity oracle made visible).
 * @param params - Attribution model + date range. model is required.
 */
export function useAttributionReconciliation(params: {
  model: AttributionModel;
  from?: string;
  to?: string;
}) {
  return useQuery({
    queryKey: [
      ...ANALYTICS_QUERY_KEY,
      'attribution-reconciliation',
      params.model,
      params.from,
      params.to,
    ],
    queryFn: () => analyticsApi.getAttributionReconciliation(params),
    staleTime: 5 * 60_000,
  });
}

/**
 * useChannelRoas — per-channel attributed ÷ ad spend (blending ad_spend_ledger).
 * @param params - Attribution model + date range. model is required.
 */
export function useChannelRoas(params: {
  model: AttributionModel;
  from?: string;
  to?: string;
}) {
  return useQuery({
    queryKey: [
      ...ANALYTICS_QUERY_KEY,
      'channel-roas',
      params.model,
      params.from,
      params.to,
    ],
    queryFn: () => analyticsApi.getChannelRoas(params),
    staleTime: 5 * 60_000,
  });
}
