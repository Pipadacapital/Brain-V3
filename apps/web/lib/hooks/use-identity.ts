'use client';

/**
 * Identity hooks — react-query bindings for the identity control-plane BFF endpoints (P0-C).
 *
 * Query keys are prefixed with 'identity' so they auto-invalidate on brand switch when
 * brand-switcher.tsx invalidates by prefix. Customer 360 is the first slice.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { identityApi } from '@/lib/api/client';
import type {
  ErasureResultResponse,
  MergeResolveResultResponse,
  UnmergeResultResponse,
} from '@/lib/api/types';

export const IDENTITY_QUERY_KEY = ['identity'] as const;

/**
 * useCustomers — paginated customer BROWSE for the active brand (the discover front-door).
 * Always enabled (an empty filter lists the most-recent customers); search/lifecycle/page are part
 * of the query key so changing any re-fetches. placeholderData keeps the table stable while paging.
 * Counts only — never raw PII.
 */
export function useCustomers(params: {
  lifecycle?: string;
  search?: string;
  /** Business (RFM/lifecycle) segment filter — VIP/loyal/at_risk/churned/first_time_buyer/window_shopper. */
  segment?: string;
  /** Acquisition-SOURCE drilldown (P3) — first-touch source from gold_customer_360 (the UTM-matrix drilldown). */
  acquisitionSource?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: [
      ...IDENTITY_QUERY_KEY,
      'customers',
      params.lifecycle ?? '',
      params.search?.trim() ?? '',
      params.segment ?? '',
      params.acquisitionSource ?? '',
      params.limit ?? 25,
      params.offset ?? 0,
    ],
    queryFn: () => identityApi.listCustomers(params),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}

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

/** useMergeReviews — pending merge candidates for the active brand. */
export function useMergeReviews() {
  return useQuery({
    queryKey: [...IDENTITY_QUERY_KEY, 'merge-reviews'],
    queryFn: () => identityApi.listMergeReviews(),
    staleTime: 30_000,
  });
}

/** useResolveMergeReview — approve (merge) or reject a candidate; refreshes the queue. */
export function useResolveMergeReview() {
  const qc = useQueryClient();
  return useMutation<MergeResolveResultResponse, unknown, { reviewId: string; decision: 'merge' | 'reject' }>({
    mutationKey: [...IDENTITY_QUERY_KEY, 'resolve-merge-review'],
    mutationFn: ({ reviewId, decision }) => identityApi.resolveMergeReview(reviewId, decision),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY });
    },
  });
}

/** useUnmergeCustomer — split a merged customer back out; refreshes identity views. */
export function useUnmergeCustomer() {
  const qc = useQueryClient();
  return useMutation<UnmergeResultResponse, unknown, string>({
    mutationKey: [...IDENTITY_QUERY_KEY, 'unmerge-customer'],
    mutationFn: (brainId: string) => identityApi.unmergeCustomer(brainId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY });
    },
  });
}
