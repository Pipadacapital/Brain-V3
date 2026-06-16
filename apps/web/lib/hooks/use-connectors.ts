'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { connectorsApi } from '@/lib/api/client';

export const CONNECTORS_QUERY_KEY = ['connectors'] as const;

export function useConnectorList() {
  return useQuery({
    queryKey: [...CONNECTORS_QUERY_KEY, 'list'],
    queryFn: () => connectorsApi.list(),
  });
}

export function useConnectorStatus(connectorId: string) {
  return useQuery({
    queryKey: [...CONNECTORS_QUERY_KEY, connectorId, 'status'],
    queryFn: () => connectorsApi.getStatus(connectorId),
    enabled: !!connectorId,
    refetchInterval: 30_000, // poll every 30s for live status
  });
}

export function useShopifyInstallUrl() {
  return useMutation({
    mutationFn: (shop: string) => connectorsApi.getShopifyInstallUrl(shop),
  });
}

export function useDisconnectConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectorId: string) => connectorsApi.disconnect(connectorId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONNECTORS_QUERY_KEY });
    },
  });
}
