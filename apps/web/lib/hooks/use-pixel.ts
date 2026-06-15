'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pixelApi } from '@/lib/api/client';

export const PIXEL_QUERY_KEY = ['pixel'] as const;

export function usePixelInstallation() {
  return useQuery({
    queryKey: [...PIXEL_QUERY_KEY, 'installation'],
    queryFn: () => pixelApi.getInstallation(),
  });
}

export function usePixelHealth() {
  return useQuery({
    queryKey: [...PIXEL_QUERY_KEY, 'health'],
    queryFn: () => pixelApi.getHealth(),
    refetchInterval: 15_000, // poll for status update
  });
}

export function useVerifyPixel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => pixelApi.verify(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PIXEL_QUERY_KEY });
    },
  });
}
