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

import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '@/lib/api/client';

export const ANALYTICS_QUERY_KEY = ['analytics'] as const;

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
 * useRecentActivity — fetches the latest N ledger rows.
 * @param limit - Max rows (default 20).
 */
export function useRecentActivity(limit = 20) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'recent-activity', limit],
    queryFn: () => analyticsApi.getRecentActivity(limit),
    staleTime: 60_000, // 1 minute — event feed refreshes more often
    refetchInterval: 60_000,
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
