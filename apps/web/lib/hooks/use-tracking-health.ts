'use client';

/**
 * Tracking Center hooks — react-query bindings for the Phase 1 Track C BFF endpoints.
 *
 * Query keys are prefixed with 'analytics' so they auto-invalidate on brand switch
 * (brand-switcher.tsx calls queryClient.invalidateQueries({ queryKey: ['analytics'] })).
 *
 * Live Verification: useTrackingHealth polls on a fast cadence so the
 * "waiting for your first event…" → "✅ first event received" flip happens shortly
 * after a real Bronze event lands — never faked, driven only by the BFF response.
 */

import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '@/lib/api/client';
import { ANALYTICS_QUERY_KEY } from './use-analytics';

/** Poll cadence for the live first-event verification (ms). */
const LIVE_POLL_MS = 10_000;

/**
 * useTrackingHealth — pixel-collection health for the active brand.
 *
 * @param options.livePoll - when true (default), refetches every LIVE_POLL_MS so the
 *   first-event flip + freshness stay live. Pass false to poll on the slower cadence.
 */
export function useTrackingHealth(options?: { livePoll?: boolean }) {
  const livePoll = options?.livePoll ?? true;
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'tracking-health'],
    queryFn: () => analyticsApi.getTrackingHealth(),
    staleTime: livePoll ? 0 : 60_000,
    refetchInterval: livePoll ? LIVE_POLL_MS : 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * useRecentEvents — latest N collected events (anonymized) for the Event Explorer.
 * @param limit - Max rows (default 20, capped at 50 server-side).
 */
export function useRecentEvents(limit = 20) {
  return useQuery({
    queryKey: [...ANALYTICS_QUERY_KEY, 'recent-events', limit],
    queryFn: () => analyticsApi.getRecentEvents(limit),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}
