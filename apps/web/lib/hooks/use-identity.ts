'use client';

/**
 * Identity hooks — react-query bindings for the identity control-plane BFF endpoints (P0-C).
 *
 * Query keys are prefixed with 'identity' so they auto-invalidate on brand switch when
 * brand-switcher.tsx invalidates by prefix. Customer 360 is the first slice.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { identityApi } from '@/lib/api/client';
import type { ErasureResultResponse } from '@/lib/api/types';

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

/** useVaultCoverage — counts-only PII vault coverage for the active brand. */
export function useVaultCoverage() {
  return useQuery({
    queryKey: [...IDENTITY_QUERY_KEY, 'vault-coverage'],
    queryFn: () => identityApi.getVaultCoverage(),
    staleTime: 60_000,
  });
}

/**
 * useEraseCustomer — DPDP right-to-deletion mutation. On success, invalidates identity
 * queries so the Customer 360 view + vault coverage reflect the erasure.
 */
export function useEraseCustomer() {
  const qc = useQueryClient();
  return useMutation<ErasureResultResponse, unknown, string>({
    mutationKey: [...IDENTITY_QUERY_KEY, 'erase-customer'],
    mutationFn: (brainId: string) => identityApi.eraseCustomer(brainId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY });
    },
  });
}
