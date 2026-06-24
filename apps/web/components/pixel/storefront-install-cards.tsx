'use client';

import { Loader2, Zap, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  usePixelInstallers,
  useInstallPixelProvider,
  useUninstallPixelProvider,
} from '@/lib/hooks/use-pixel';
import { BffApiError, pixelApi, type PixelInstallerDescriptor, type PixelInstallResult } from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';

/**
 * StorefrontInstallCards — the storefront-agnostic, connected-driven pixel-install surface.
 *
 * The merchant connects a storefront first; this component then renders exactly the install
 * option(s) for the storefront(s) that are connected (from GET /api/v1/pixel/installers). Adding a
 * new storefront on the backend (one PixelInstaller) surfaces a new card here with ZERO changes to
 * this component — it is fully data-driven off the registry descriptors.
 *
 * Provider-specific guidance is rendered from the install result's `meta` (Shopify's checkout
 * Web-Pixel status; WooCommerce's one-time plugin download) without special-casing the happy path.
 */

const PROVIDER_COPY: Record<string, { connectHint: string }> = {
  shopify: { connectHint: 'Connect a Shopify store to enable one-click install.' },
  woocommerce: { connectHint: 'Connect a WooCommerce store to enable one-click install.' },
};

function ProviderCard({ d, installed }: { d: PixelInstallerDescriptor; installed: boolean }) {
  const { mutate: install, isPending: installing } = useInstallPixelProvider();
  const { mutate: uninstall, isPending: removing } = useUninstallPixelProvider();

  function onInstall() {
    install(d.provider, {
      onSuccess: (res: PixelInstallResult) => {
        toast({
          title: res.already_present
            ? `Pixel already installed on ${d.displayName}`
            : `Pixel installed on ${d.displayName}`,
          description: 'The Brain Pixel is now live on your storefront — no manual paste needed.',
        });
        // Surface provider-specific follow-ups (checkout coverage / plugin version) honestly.
        if (res.meta?.webPixel && res.meta.webPixel.status === 'pending') {
          toast({ title: 'Checkout tracking pending', description: res.meta.webPixel.message });
        }
      },
      onError: (err) => {
        const description =
          err instanceof BffApiError && err.message
            ? err.message
            : `Could not install on ${d.displayName}. Try the manual snippet below.`;
        toast({ title: 'Install failed', description, variant: 'destructive' });
      },
    });
  }

  function onUninstall() {
    uninstall(d.provider, {
      onSuccess: (res) => {
        toast({
          title: res.already_absent ? 'No pixel to remove' : `Pixel removed from ${d.displayName}`,
          description: res.already_absent
            ? 'There was no Brain Pixel on the storefront.'
            : 'The Brain Pixel was removed from your storefront.',
        });
      },
      onError: (err) => {
        const description =
          err instanceof BffApiError && err.message ? err.message : 'Could not remove the pixel. Try again.';
        toast({ title: 'Remove failed', description, variant: 'destructive' });
      },
    });
  }

  const isWoo = d.provider === 'woocommerce';

  return (
    <Card data-testid={`pixel-install-card-${d.provider}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" aria-hidden="true" />
          Install automatically on {d.displayName}
        </CardTitle>
        <CardDescription>
          {d.available
            ? `Place the Brain Pixel on your connected ${d.displayName} store in one click — no theme edit, no copy-paste.`
            : PROVIDER_COPY[d.provider]?.connectHint ??
              `Connect a ${d.displayName} store to enable one-click install.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={onInstall}
            disabled={!d.available || installing || removing}
            data-testid={`btn-install-${d.provider}`}
          >
            {installing && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {installing ? 'Installing…' : installed ? `Reinstall on ${d.displayName}` : `Install on ${d.displayName}`}
          </Button>
          {d.supportsUninstall && installed && (
            <Button
              variant="outline"
              onClick={onUninstall}
              disabled={!d.available || removing || installing}
              data-testid={`btn-uninstall-${d.provider}`}
            >
              {removing && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {removing ? 'Removing…' : `Remove from ${d.displayName}`}
            </Button>
          )}
        </div>

        {/* WooCommerce one-time step: download + activate the Brain Pixel plugin (parallel of Shopify's
            one-time OAuth authorization). After that, the button above configures it in one click. */}
        {isWoo && (
          <div className="rounded-md border-l-2 border-primary pl-3 py-2 space-y-1">
            <p className="text-xs text-muted-foreground">
              One-time setup: install the Brain Pixel plugin on your WordPress site (Plugins → Add New →
              Upload), activate it, then click Install above.
            </p>
            <a href={pixelApi.wooCommercePluginUrl} download data-testid="btn-download-woo-plugin">
              <Button variant="outline" size="sm">
                <Download className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                Download Brain Pixel plugin (.zip)
              </Button>
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function StorefrontInstallCards({ installed }: { installed: boolean }) {
  const { data, isLoading } = usePixelInstallers();

  if (isLoading) {
    return <Skeleton className="h-40 w-full" data-testid="pixel-installers-loading" />;
  }
  const installers = data?.installers ?? [];
  if (installers.length === 0) return null;

  // Connected storefronts first (actionable), then the rest (with a connect hint).
  const sorted = [...installers].sort((a, b) => Number(b.available) - Number(a.available));

  return (
    <div className="space-y-4" data-testid="storefront-install-cards">
      {sorted.map((d) => (
        <ProviderCard key={d.provider} d={d} installed={installed} />
      ))}
    </div>
  );
}
