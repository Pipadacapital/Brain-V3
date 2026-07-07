'use client';

/**
 * Metrics hooks (Wave C/D) — the semantic catalog, metric lineage ("prove this number"), and the
 * contribution-margin (true-profit) read. Keys are prefixed with 'analytics' so they auto-invalidate
 * on brand switch. Every read is honest-empty / honest-zero.
 */

import { useQuery } from '@tanstack/react-query';
import { metricsApi } from '@/lib/api/client';

export const METRICS_QUERY_KEY = ['analytics', 'metrics'] as const;

/** The certified, governed semantic metric catalog (Wave D). */
export function useSemanticCatalog() {
  return useQuery({
    queryKey: [...METRICS_QUERY_KEY, 'semantic-catalog'],
    queryFn: () => metricsApi.getSemanticCatalog(),
    staleTime: 5 * 60_000,
  });
}

/** The source facts behind a metric — tables, brand-scoped row counts, producing job versions.
 *  Disabled until a metric id is chosen. `date` (YYYY-MM-DD) scopes the counts as-of that day. */
export function useMetricLineage(metric: string | null, date?: string | null) {
  return useQuery({
    queryKey: [...METRICS_QUERY_KEY, 'lineage', metric, date ?? 'all'],
    queryFn: () => metricsApi.getLineage(metric as string, date ?? null),
    enabled: Boolean(metric),
    staleTime: 5 * 60_000,
  });
}

/** True profit: net revenue → COGS → CM1 → marketing → CM2, with a cost-confidence grade. */
export function useContributionMargin(asOf?: string) {
  return useQuery({
    queryKey: [...METRICS_QUERY_KEY, 'contribution-margin', asOf ?? 'today'],
    queryFn: () => metricsApi.getContributionMargin(asOf),
    staleTime: 5 * 60_000,
    refetchInterval: 60_000,
  });
}
