'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pixelApi } from '@/lib/api/client';

export const PIXEL_QUERY_KEY = ['pixel'] as const;

export function usePixelInstallation() {
  // Read-only (SEC-0009-M01). Returns { installed: false } until provisioned.
  return useQuery({
    queryKey: [...PIXEL_QUERY_KEY, 'installation'],
    queryFn: () => pixelApi.getInstallation(),
  });
}

export function useProvisionPixel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (targetHost: string) => pixelApi.provision(targetHost),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PIXEL_QUERY_KEY });
    },
  });
}

/**
 * Set or clear the brand's first-party CNAME ingest host (manager+). Pass null to clear. On success
 * the installation query refreshes so the snippet reflects the first-party host.
 */
export function useSetPixelIngestHost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (host: string | null) => pixelApi.setIngestHost(host),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PIXEL_QUERY_KEY });
    },
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

/**
 * Production install path: auto-inject the pixel onto the connected Shopify storefront
 * (no manual snippet paste). On success the installation + health queries refresh, flipping
 * the status to installed/connected.
 */
export function useInstallPixelShopify() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => pixelApi.installShopify(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PIXEL_QUERY_KEY });
    },
  });
}

/**
 * Removal path: delete the Brain ScriptTag from the connected Shopify storefront and clear install
 * state. On success the installation + health queries refresh, flipping the status to not-installed.
 */
export function useUninstallPixelShopify() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => pixelApi.uninstallShopify(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PIXEL_QUERY_KEY });
    },
  });
}

// ── Storefront-agnostic install surface (feat-universal-pixel) ────────────────

/**
 * The install options available to this brand — connected-storefront-driven. Each descriptor says
 * whether that storefront is connected (available) and supports programmatic uninstall.
 */
export function usePixelInstallers() {
  return useQuery({
    queryKey: [...PIXEL_QUERY_KEY, 'installers'],
    queryFn: () => pixelApi.listInstallers(),
  });
}

/** Run the installer for a connected storefront (shopify | woocommerce | …). */
export function useInstallPixelProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) => pixelApi.installProvider(provider),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PIXEL_QUERY_KEY });
    },
  });
}

/** Remove the pixel from a storefront (when the installer supports it). */
export function useUninstallPixelProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) => pixelApi.uninstallProvider(provider),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PIXEL_QUERY_KEY });
    },
  });
}
