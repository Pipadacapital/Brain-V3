'use client';

/**
 * Identity hooks — react-query bindings for the identity control-plane BFF endpoints (P0-C).
 *
 * Query keys are prefixed with 'identity' so they auto-invalidate on brand switch when
 * brand-switcher.tsx invalidates by prefix. Customer 360 is the first slice.
 */
import { useQuery } from '@tanstack/react-query';
import { identityApi } from '@/lib/api/client';

export const IDENTITY_QUERY_KEY = ['identity'] as const;

/**
 * useCustomer360 — fetch the resolved customer profile for a brain_id.
 * Disabled until a non-empty brain_id is entered (no fetch on an empty search box).
 */
export function useCustomer360(brainId: string) {
  const trimmed = brainId.trim();
  return useQuery({
    queryKey: [...IDENTITY_QUERY_KEY, 'customer-360', trimmed],
    queryFn: () => identityApi.getCustomer360(trimmed),
    enabled: trimmed.length > 0,
    staleTime: 60_000,
  });
}
