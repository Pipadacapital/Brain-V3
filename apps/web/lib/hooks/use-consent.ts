'use client';

/**
 * Consent / Compliance hooks — react-query bindings for the D13 consent BFF endpoints
 * (feat-d13-consent-cancontact Track C).
 *
 * Query keys are prefixed with 'consent' so they auto-invalidate on brand switch when
 * brand-switcher.tsx calls queryClient.invalidateQueries({ queryKey: ['consent'] }).
 * (The brand switcher already invalidates 'analytics' + dashboard; consent is a sibling
 * — see brand-switcher.tsx; we add 'consent' to its invalidation set.)
 *
 * staleTime: coverage/suppression = 60s (state changes are operationally slow but the
 * <15min withdrawal SLA means we don't want very stale reads); gate-activity = 30s
 * (a live decision feed); window-config = 60s (recomputes in_window_now server-side).
 */

import { useQuery } from '@tanstack/react-query';
import { consentApi } from '@/lib/api/client';

export const CONSENT_QUERY_KEY = ['consent'] as const;

/** useConsentCoverage — per-category granted/withdrawn subject counts. */
export function useConsentCoverage() {
  return useQuery({
    queryKey: [...CONSENT_QUERY_KEY, 'coverage'],
    queryFn: () => consentApi.getCoverage(),
    staleTime: 60_000,
  });
}

/** useConsentSuppressionSummary — marketing suppression counts (fail-closed denom). */
export function useConsentSuppressionSummary() {
  return useQuery({
    queryKey: [...CONSENT_QUERY_KEY, 'suppression-summary'],
    queryFn: () => consentApi.getSuppressionSummary(),
    staleTime: 60_000,
  });
}

/** useConsentGateActivity — last-N can_contact() decisions by reason. */
export function useConsentGateActivity() {
  return useQuery({
    queryKey: [...CONSENT_QUERY_KEY, 'gate-activity'],
    queryFn: () => consentApi.getGateActivity(),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

/** useConsentWindowConfig — the read-only 9–9 IST send window (server-computed). */
export function useConsentWindowConfig() {
  return useQuery({
    queryKey: [...CONSENT_QUERY_KEY, 'window-config'],
    queryFn: () => consentApi.getWindowConfig(),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
