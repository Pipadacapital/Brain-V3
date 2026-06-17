'use client';

import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '@/lib/api/client';

export const DASHBOARD_QUERY_KEY = ['dashboard'] as const;

// Sources: arch plan §6.4 — Postgres control-plane ONLY. No OLAP/StarRocks.

export function useBrandSummary() {
  return useQuery({
    queryKey: [...DASHBOARD_QUERY_KEY, 'brand-summary'],
    queryFn: () => dashboardApi.getBrandSummary(),
    staleTime: 60_000,
  });
}

export function useConnectionStatus() {
  return useQuery({
    queryKey: [...DASHBOARD_QUERY_KEY, 'connection-status'],
    queryFn: () => dashboardApi.getConnectionStatus(),
    staleTime: 30_000,
    refetchInterval: 60_000, // refresh every minute for live connector status
  });
}

export function useDataStatus() {
  return useQuery({
    queryKey: [...DASHBOARD_QUERY_KEY, 'data-status'],
    queryFn: () => dashboardApi.getDataStatus(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useOnboardingProgress() {
  return useQuery({
    queryKey: [...DASHBOARD_QUERY_KEY, 'onboarding-progress'],
    queryFn: () => dashboardApi.getOnboardingProgress(),
    staleTime: 30_000,
  });
}

/**
 * Realized revenue hook — keyed under DASHBOARD_QUERY_KEY so it auto-invalidates
 * when the brand switcher fires (brand-switcher.tsx:13 invalidates the full prefix).
 *
 * @param asOf - Optional YYYY-MM-DD date for the as_of snapshot (server defaults to today).
 *
 * D-6: cache invalidation on brand switch — the brand-switcher already calls
 * queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY }) which invalidates
 * all queries prefixed with ['dashboard'], including [...DASHBOARD_QUERY_KEY, 'realized-revenue'].
 */
export function useRealizedRevenue(asOf?: string) {
  return useQuery({
    queryKey: [...DASHBOARD_QUERY_KEY, 'realized-revenue', asOf ?? 'today'],
    queryFn: () => dashboardApi.getRealizedRevenue(asOf),
    staleTime: 60_000,
  });
}
