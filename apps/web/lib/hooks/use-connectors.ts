'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { connectorsApi } from '@/lib/api/client';

export const CONNECTORS_QUERY_KEY = ['connectors'] as const;
export const MARKETPLACE_QUERY_KEY = ['connectors', 'marketplace'] as const;

export function useConnectorList() {
  return useQuery({
    queryKey: [...CONNECTORS_QUERY_KEY, 'list'],
    queryFn: () => connectorsApi.list(),
  });
}

/**
 * useMarketplace — TanStack Query hook for the category-organized marketplace.
 * Fetches GET /api/v1/connectors → MarketplaceTile[] (catalog ⨝ instance).
 * D-10: unwrap handled in connectorsApi.getMarketplace().
 */
export function useMarketplace() {
  return useQuery({
    queryKey: MARKETPLACE_QUERY_KEY,
    queryFn: () => connectorsApi.getMarketplace(),
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

/**
 * useConnectConnector — generic connect mutation.
 * oauth ⇒ caller redirects to oauth_url.
 * credential ⇒ tile flips to connected.
 * On success: invalidates the marketplace query so tiles update.
 */
export function useConnectConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      type,
      shop_domain,
      credentials,
    }: {
      type: string;
      shop_domain?: string;
      credentials?: Record<string, string>;
    }) => connectorsApi.connect(type, { shop_domain, credentials }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MARKETPLACE_QUERY_KEY });
    },
  });
}

export function useDisconnectConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectorId: string) => connectorsApi.disconnect(connectorId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONNECTORS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: MARKETPLACE_QUERY_KEY });
    },
  });
}
