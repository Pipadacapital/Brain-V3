'use client';

/**
 * Recommendation hooks — react-query bindings for the decision engine (doc 09).
 *
 * Query key prefixed with 'recommendations' so it auto-invalidates on brand switch.
 * Refreshing (running the detectors) invalidates the list so new/expired recs surface.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { recommendationApi } from '@/lib/api/client';

export const RECOMMENDATIONS_QUERY_KEY = ['recommendations'] as const;

/** useRecommendations — the active brand's open recommendations (honest no_data / has_data). */
export function useRecommendations() {
  return useQuery({
    queryKey: [...RECOMMENDATIONS_QUERY_KEY, 'list'],
    queryFn: () => recommendationApi.list(),
    staleTime: 60_000,
  });
}

/** useRefreshRecommendations — run the detectors, then refresh the list. */
export function useRefreshRecommendations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => recommendationApi.refresh(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: RECOMMENDATIONS_QUERY_KEY });
    },
  });
}
