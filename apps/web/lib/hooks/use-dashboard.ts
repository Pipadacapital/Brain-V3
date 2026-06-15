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
