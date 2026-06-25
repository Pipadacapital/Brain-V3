'use client';

import { Zap, Download, Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Alert } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import Link from 'next/link';
import {
  usePixelInstallers,
  useInstallPixelProvider,
  useUninstallPixelProvider,
} from '@/lib/hooks/use-pixel';
import {
  BffApiError,
  pixelApi,
  type PixelInstallerDescriptor,
  type PixelInstallResult,
} from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';

/**
 * StorefrontInstallCards — the connected-storefront-driven, one-click install surface.
 *
 * INSTALL-TARGET RULE:
 *   - When a storefront IS connected (any installer `available`), show ONLY the install
 *     action(s) for the connected storefront(s).
 *   - When NO storefront is connected, show ALL install options with a "connect first"
 *     hint, so the merchant knows what to do next.
 *
 * Fully data-driven off GET /api/v1/pixel/installers — registering a new PixelInstaller
 * on the backend surfaces a new option here with ZERO changes to this component.
 */

const PROVIDER_COPY: Record<string, { connectHint: string }> = {
  shopify: { connectHint: 'Connect a Shopify store to enable one-click install.' },
  woocommerce: { connectHint: 'Connect a WooCommerce store to enable one-click install.' },
};

/** A connected storefront: a real, working install action. */
function ConnectedProviderCard({ d }: { d: PixelInstallerDescriptor }) {
  const { mutate: install, isPending: installing } = useInstallPixelProvider();
  const { mutate: uninstall, isPending: removing } = useUninstallPixelProvider();

  function onInstall() {
    install(d.provider, {
      onSuccess: (res: PixelInstallResult) => {
        toast({
          title: res.already_present
            ? `Pixel already live on ${d.displayName}`
            : `Pixel installed on ${d.displayName}`,
          description: 'The Brain Pixel is live on your storefront — no manual paste needed.',
        });
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
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <Zap className="size-4 text-primary" aria-hidden="true" />
          Install on {d.displayName}
        </span>
      }
      description={`Place the Brain Pixel on your connected ${d.displayName} store in one click — no theme edit, no copy-paste.`}
      meta={<StatusBadge tone="success">Connected</StatusBadge>}
      data-testid={`pixel-install-card-${d.provider}`}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onInstall} loading={installing} disabled={removing} data-testid={`btn-install-${d.provider}`}>
            <Zap />
            {installing ? 'Installing…' : `Install on ${d.displayName}`}
          </Button>
          {d.supportsUninstall && (
            <Button
              variant="outline"
              onClick={onUninstall}
              loading={removing}
              disabled={installing}
              data-testid={`btn-uninstall-${d.provider}`}
            >
              {removing ? 'Removing…' : 'Remove pixel'}
            </Button>
          )}
        </div>

        {/* WooCommerce one-time prerequisite: install + activate the plugin (parallel to Shopify OAuth). */}
        {isWoo && (
          <Alert variant="neutral" title="One-time setup">
            <p>
              Install the Brain Pixel plugin on your WordPress site (Plugins → Add New → Upload), activate
              it, then click Install above.
            </p>
            <a href={pixelApi.wooCommercePluginUrl} download data-testid="btn-download-woo-plugin" className="mt-2 inline-block no-underline">
              <Button variant="outline" size="sm">
                <Download />
                Download plugin (.zip)
              </Button>
            </a>
          </Alert>
        )}
      </div>
    </SectionCard>
  );
}

/**
 * No storefront connected yet: surface every option as a "connect first" prompt
 * that links to the connectors marketplace.
 */
function ConnectPrompt({ options }: { options: PixelInstallerDescriptor[] }) {
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <Plug className="size-4 text-muted-foreground" aria-hidden="true" />
          Install automatically
        </span>
      }
      description="Connect a storefront to install the Brain Pixel in one click — no theme edit or copy-paste. Until then, use the manual snippet below."
      actions={
        <Button asChild size="sm">
          <Link href="/settings/connectors">Connect a storefront</Link>
        </Button>
      }
      data-testid="storefront-connect-prompt"
    >
      <ul className="space-y-2">
        {options.map((d) => (
          <li
            key={d.provider}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            data-testid={`pixel-connect-hint-${d.provider}`}
          >
            <span className="text-sm font-medium text-foreground">{d.displayName}</span>
            <span className="text-xs text-muted-foreground">
              {PROVIDER_COPY[d.provider]?.connectHint ?? `Connect a ${d.displayName} store first.`}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

export function StorefrontInstallCards() {
  const { data, isLoading } = usePixelInstallers();

  if (isLoading) {
    return <Skeleton className="h-40 w-full rounded-lg" data-testid="pixel-installers-loading" />;
  }

  const installers = data?.installers ?? [];
  if (installers.length === 0) return null;

  const connected = installers.filter((d) => d.available);

  // RULE: any storefront connected ⇒ show ONLY the connected one(s); else show all as connect prompts.
  if (connected.length > 0) {
    return (
      <div className="space-y-6" data-testid="storefront-install-cards">
        {connected.map((d) => (
          <ConnectedProviderCard key={d.provider} d={d} />
        ))}
      </div>
    );
  }

  return (
    <div data-testid="storefront-install-cards">
      <ConnectPrompt options={installers} />
    </div>
  );
}
