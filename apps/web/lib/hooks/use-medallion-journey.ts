'use client';

/**
 * useMedallionJourney — the Data Journey observability roll-up (Bronze → Silver → Identity →
 * Gold → Serving).
 *
 * This is a LIVE pipeline monitor: it refetches on a 30s interval so a user watching their data
 * flow through the medallion sees the stage freshness/health update without a manual reload. Shares
 * the 'analytics' query-key prefix so a brand switch auto-invalidates it (same pattern as the other
 * analytics hooks). Reads ONLY the BFF (never the DB/Iceberg/Neo4j directly).
 */

import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '@/lib/api/client';
import { ANALYTICS_QUERY_KEY } from './use-analytics';

/** Auto-refresh cadence for the live pipeline monitor. */
const MEDALLION_REFETCH_MS = 30_000;

export function useMedallionJourney() {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'medallion-journey'],
    queryFn: () => analyticsApi.getMedallionJourney(),
    staleTime: MEDALLION_REFETCH_MS,
    refetchInterval: MEDALLION_REFETCH_MS,
  });
}
