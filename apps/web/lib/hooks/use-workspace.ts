'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { workspaceApi, brandApi } from '@/lib/api/client';
import type { CreateWorkspaceRequest, CreateBrandRequest } from '@/lib/api/types';

export const WORKSPACE_QUERY_KEY = ['workspace'] as const;
export const BRAND_QUERY_KEY = ['brand'] as const;

export function useWorkspaceList() {
  return useQuery({
    queryKey: [...WORKSPACE_QUERY_KEY, 'list'],
    queryFn: () => workspaceApi.list(),
  });
}

export function useWorkspace(id: string) {
  return useQuery({
    queryKey: [...WORKSPACE_QUERY_KEY, id],
    queryFn: () => workspaceApi.get(id),
    enabled: !!id,
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWorkspaceRequest) => workspaceApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
    },
  });
}

export function useBrandList() {
  return useQuery({
    queryKey: [...BRAND_QUERY_KEY, 'list'],
    queryFn: () => brandApi.list(),
  });
}

export function useBrand(id: string) {
  return useQuery({
    queryKey: [...BRAND_QUERY_KEY, id],
    queryFn: () => brandApi.get(id),
    enabled: !!id,
  });
}

export function useCreateBrand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateBrandRequest) => brandApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BRAND_QUERY_KEY });
    },
  });
}
