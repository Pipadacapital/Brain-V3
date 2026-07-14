'use client';

/**
 * useEntitlements — readiness-driven progressive unlock (P2).
 *
 * Server-driven eligibility for gated centers + connector categories. The nav + connector marketplace
 * consume this so a center/integration is only offered once the data foundation can support it — and
 * a locked item explains exactly what unlocks it. Auto-invalidates on brand switch via the query key.
 */

import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '@/lib/api/client';
import type { EntitlementEntry } from '@/lib/api/types';

const ENTITLEMENTS_QUERY_KEY = ['entitlements'] as const;

export function useEntitlements() {
  return useQuery({
    queryKey: ENTITLEMENTS_QUERY_KEY,
    queryFn: () => analyticsApi.getEntitlements(),
    staleTime: 60_000,
  });
}

/** Look up a center's entitlement; absent → treated as eligible (default-allow for ungated centers). */
export function centerEntitlement(
  entries: EntitlementEntry[] | undefined,
  key: string,
): EntitlementEntry {
  return entries?.find((e) => e.key === key) ?? { key, eligible: true, reason: null, unlock_hint: null };
}
