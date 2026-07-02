'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { workspaceApi, brandApi, onboardingApi } from '@/lib/api/client';
import type { ProvisionOnboardingRequest } from '@/lib/api/types';

export const WORKSPACE_QUERY_KEY = ['workspace'] as const;
export const BRAND_QUERY_KEY = ['brand'] as const;

export function useWorkspaceList() {
  return useQuery({
    queryKey: [...WORKSPACE_QUERY_KEY, 'list'],
    queryFn: () => workspaceApi.list(),
  });
}

export function useBrandList() {
  return useQuery({
    queryKey: [...BRAND_QUERY_KEY, 'list'],
    queryFn: () => brandApi.list(),
  });
}


/**
 * feat-onboarding-ux: the merged create step. Provisions workspace + first brand (+ pixel)
 * in one atomic server transaction. Idempotent per user (Back→resubmit returns the existing
 * org/brand). Invalidates both workspace and brand caches on success.
 */
export function useProvisionOnboarding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ProvisionOnboardingRequest) => onboardingApi.provision(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: BRAND_QUERY_KEY });
    },
  });
}
