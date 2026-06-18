'use client';

/**
 * Conversion-Feedback / CAPI hooks — react-query bindings for the Phase 6 CAPI BFF
 * endpoints (feat-capi-conversion-feedback Track C).
 *
 * Query keys are prefixed with 'capi-feedback' so they auto-invalidate on brand switch
 * when brand-switcher.tsx calls invalidateQueries({ queryKey: CAPI_FEEDBACK_QUERY_KEY }).
 *
 * staleTime: summary/events/deletions = 30s — the passback log + the ≤15-min deletion
 * path mean we want a reasonably-live read without hammering the BFF; refetchInterval
 * 30s keeps the deletion feed fresh enough to SHOW the retroactive-deletion path firing.
 */

import { useQuery } from '@tanstack/react-query';
import { capiFeedbackApi } from '@/lib/api/client';

export const CAPI_FEEDBACK_QUERY_KEY = ['capi-feedback'] as const;

/** useCapiFeedbackSummary — passed-back vs blocked-by-consent + match quality + dev boundary. */
export function useCapiFeedbackSummary() {
  return useQuery({
    queryKey: [...CAPI_FEEDBACK_QUERY_KEY, 'summary'],
    queryFn: () => capiFeedbackApi.getSummary(),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

/** useCapiFeedbackEvents — the last-N passback log rows (default-closed proof + dev boundary). */
export function useCapiFeedbackEvents() {
  return useQuery({
    queryKey: [...CAPI_FEEDBACK_QUERY_KEY, 'events'],
    queryFn: () => capiFeedbackApi.getEvents(),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

/** useCapiFeedbackDeletions — the last-N retroactive-deletion requests (≤15-min path). */
export function useCapiFeedbackDeletions() {
  return useQuery({
    queryKey: [...CAPI_FEEDBACK_QUERY_KEY, 'deletions'],
    queryFn: () => capiFeedbackApi.getDeletions(),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
