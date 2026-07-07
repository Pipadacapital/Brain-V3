'use client';

/**
 * Journey hooks (Wave B.3) — react-query bindings for the journey deep-dive surfaces.
 *
 * Keys are prefixed with 'analytics' so they auto-invalidate on brand switch (brand-switcher.tsx
 * invalidates queryKey ['analytics']). Each read is honest-empty: a no_data state renders as
 * "no journey yet", never a fabricated timeline.
 */

import { useQuery } from '@tanstack/react-query';
import { journeyApi } from '@/lib/api/client';

export const JOURNEY_QUERY_KEY = ['analytics', 'journey'] as const;

/** Trace the touchpoints that preceded an order (+ identity evidence). Disabled until an order id. */
export function useJourneyTrace(orderId: string | null, lookbackDays?: number) {
  return useQuery({
    queryKey: [...JOURNEY_QUERY_KEY, 'trace', orderId, lookbackDays ?? 30],
    queryFn: () => journeyApi.getTrace(orderId as string, lookbackDays),
    enabled: Boolean(orderId),
    staleTime: 60_000,
  });
}

/** A customer's newest-first journey timeline. Disabled until a brain_id. */
export function useCustomerJourney(brainId: string | null, limit?: number) {
  return useQuery({
    queryKey: [...JOURNEY_QUERY_KEY, 'customer', brainId, limit ?? 50],
    queryFn: () => journeyApi.getCustomerJourney(brainId as string, { limit }),
    enabled: Boolean(brainId),
    staleTime: 60_000,
  });
}

/** Compare two customers' journeys side by side (t_minus_conversion per touch). */
export function useJourneyCompare(left: string | null, right: string | null) {
  return useQuery({
    queryKey: [...JOURNEY_QUERY_KEY, 'compare', left, right],
    queryFn: () => journeyApi.getCompare(left as string, right as string),
    enabled: Boolean(left) && Boolean(right),
    staleTime: 60_000,
  });
}
