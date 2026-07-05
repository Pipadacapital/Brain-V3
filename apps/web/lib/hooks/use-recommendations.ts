'use client';

/**
 * Recommendation hooks — react-query bindings for the decision engine (doc 09).
 *
 * Query key prefixed with 'recommendations' so it auto-invalidates on brand switch.
 * Refreshing (running the detectors) invalidates the list so new/expired recs surface.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { recommendationApi } from '@/lib/api/client';
import type { RecommendationActionKind } from '@/lib/api/types';

const RECOMMENDATIONS_QUERY_KEY = ['recommendations'] as const;

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

/**
 * useRecommendationAction — record a human action on a recommendation (the decision-feedback loop).
 * Appends to the append-only action ledger; 'dismissed'/'reopened' move the rec's status, so we
 * invalidate the list to reflect the new open set (a dismissed rec drops off the Morning Brief).
 */
export function useRecommendationAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      recommendationId,
      action,
      reason,
    }: {
      recommendationId: string;
      action: RecommendationActionKind;
      reason?: string;
    }) => recommendationApi.action(recommendationId, action, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: RECOMMENDATIONS_QUERY_KEY });
    },
  });
}
