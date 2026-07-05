'use client';

/**
 * useFoundationHealth — the Data Foundation Health readiness verdict (P1).
 *
 * One tier (blocked|building|ready|healthy) + the progression checklist + the next step. Drives the
 * dashboard's foundation-first surface so a brand never lands on empty/misleading charts — it sees
 * what's ready, what's missing, and exactly what to do next. Auto-invalidates on brand switch via
 * the query-key prefix.
 */

import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '@/lib/api/client';

const FOUNDATION_HEALTH_QUERY_KEY = ['foundation-health'] as const;

export function useFoundationHealth() {
  return useQuery({
    queryKey: FOUNDATION_HEALTH_QUERY_KEY,
    queryFn: () => analyticsApi.getFoundationHealth(),
    staleTime: 60_000,
  });
}
