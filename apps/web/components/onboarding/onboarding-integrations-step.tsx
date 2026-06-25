'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ArrowRight, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { SectionCard } from '@/components/ui/section-card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorCard } from '@/components/ui/error-card';
import { Skeleton } from '@/components/ui/skeleton';
import { sessionApi } from '@/lib/api/client';
import { useConnectorList, useShopifyInstallUrl } from '@/lib/hooks/use-connectors';
import { toast } from '@/components/ui/toaster';
import type { ConnectorListItem, ConnectorStatus } from '@/lib/api/types';
import { BffApiError, userFacingMessage } from '@/lib/api/client';

/**
 * Step 2 of 3 — Storefront connection.
 *
 * - Onboarding only offers STOREFRONT connectors (Shopify, WooCommerce) — order truth is the
 *   data foundation that everything else (attribution, revenue, identity) is built on, so we
 *   capture it first. Ads/payments/logistics/messaging connectors live in Settings, post-setup.
 * - Shopify: connect-now (OAuth) or skip.
 * - Connector status is shown with a labelled StatusBadge (never colour-only).
 * - OAuth failure leaves the source Disconnected with retry — does NOT block the wizard.
 * - "Skip for now" → advance onboarding_status to integration_selected → Step 3.
 */

const STATUS_TONE: Record<ConnectorStatus, { tone: StatusTone; label: string; pulse?: boolean }> = {
  connected: { tone: 'success', label: 'Connected' },
  disconnected: { tone: 'neutral', label: 'Not connected' },
  error: { tone: 'destructive', label: 'Needs attention — retry to reconnect' },
};

function ConnectorWizardCard({
  item,
  onAdvance,
}: {
  item: ConnectorListItem;
  onAdvance: () => Promise<void>;
}) {
  const { mutate: getShopifyUrl, isPending: isConnecting } = useShopifyInstallUrl();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [shopDomain, setShopDomain] = useState('');

  const isConnected = !!item.instance;
  const status = item.instance?.status;

  function handleConnect() {
    if (item.provider !== 'shopify') return;
    // Shopify OAuth needs the store domain; the backend 400s without ?shop=.
    const shop = shopDomain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!shop) {
      setConnectError('Enter your Shopify store domain (e.g. my-store.myshopify.com).');
      return;
    }
    setConnectError(null);
    getShopifyUrl(shop, {
      onSuccess: (data) => {
        // Redirect to Shopify OAuth — wizard resumes on return via onboarding_status routing.
        window.location.href = data.install_url;
      },
      onError: (err) => {
        const msg =
          err instanceof BffApiError ? err.message : 'Could not start Shopify connection.';
        setConnectError(msg);
        // OAuth failure does NOT block wizard — user can skip.
        toast({
          title: 'Connection failed',
          description: msg,
          variant: 'destructive',
        });
      },
    });
  }

  const statusMeta = isConnected && status ? STATUS_TONE[status] : null;

  return (
    <SectionCard
      data-testid={`connector-card-${item.provider}`}
      title={item.display_name}
      description={item.description}
      actions={
        item.coming_soon ? (
          <StatusBadge tone="neutral">Coming soon</StatusBadge>
        ) : statusMeta ? (
          <StatusBadge
            tone={statusMeta.tone}
            pulse={statusMeta.pulse}
            role="status"
            aria-label={`${item.display_name} status: ${statusMeta.label}`}
          >
            {statusMeta.label}
          </StatusBadge>
        ) : undefined
      }
    >
      {connectError && (
        <Alert variant="warning" className="mb-4">
          {connectError} You can skip and connect later.
        </Alert>
      )}

      {item.coming_soon ? (
        <Button
          variant="outline"
          disabled
          aria-label={`${item.display_name} — Coming soon`}
          aria-disabled="true"
        >
          Coming soon
        </Button>
      ) : isConnected ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {item.instance?.shop_domain && (
            <p className="text-sm font-medium tabular-nums text-foreground">
              {item.instance.shop_domain}
            </p>
          )}
          <Button
            size="sm"
            onClick={onAdvance}
            className="ml-auto"
            data-testid={`btn-continue-after-connect-${item.provider}`}
          >
            Continue
            <ArrowRight className="ml-2 size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {item.provider === 'shopify' && (
            <div className="space-y-1.5">
              <Label htmlFor={`shop-${item.provider}`}>Your Shopify store domain</Label>
              <Input
                id={`shop-${item.provider}`}
                value={shopDomain}
                onChange={(e) => setShopDomain(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConnect();
                }}
                placeholder="my-store.myshopify.com"
                autoComplete="off"
                inputMode="url"
                data-testid={`input-shop-${item.provider}`}
              />
            </div>
          )}
          <Button
            onClick={handleConnect}
            loading={isConnecting}
            disabled={item.provider === 'shopify' && !shopDomain.trim()}
            data-testid={`btn-connect-${item.provider}`}
          >
            {isConnecting ? 'Connecting…' : `Connect ${item.display_name}`}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

export function OnboardingIntegrationsStep() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useConnectorList();
  const [isAdvancing, setIsAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);

  async function advance() {
    setIsAdvancing(true);
    setAdvanceError(null);
    try {
      await sessionApi.advanceOnboarding({ to: 'integration_selected' });
      router.push('/onboarding/done');
    } catch (err) {
      const msg =
        err instanceof BffApiError
          ? userFacingMessage(err)
          : 'Could not save progress. Please try again.';
      setAdvanceError(msg);
      setIsAdvancing(false);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading storefront connectors…">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-40 w-full" aria-hidden="true" />
        ))}
      </div>
    );
  }

  if (error) {
    return <ErrorCard error={error} retry={refetch} />;
  }

  // Onboarding offers ONLY storefront connectors — order truth is the data foundation captured
  // first; every other connector category is handled later in Settings (data foundation before
  // dashboards). `category` is carried on ConnectorListItem from the web-api catalog.
  const storefrontConnectors = (data ?? []).filter((item) => item.category === 'storefront');

  return (
    <div className="space-y-6">
      {advanceError && (
        <Alert variant="destructive">{advanceError}</Alert>
      )}

      {storefrontConnectors.length === 0 ? (
        <SectionCard>
          <EmptyState
            icon={<Store aria-hidden="true" />}
            title="No storefront connectors available"
            description="We couldn’t load any storefront integrations right now. You can continue and connect your store later from Settings."
          />
        </SectionCard>
      ) : (
        <div className="space-y-4">
          {storefrontConnectors.map((item) => (
            <ConnectorWizardCard key={item.provider} item={item} onAdvance={advance} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <p className="text-sm text-muted-foreground">
          You can always connect more integrations later from Settings.
        </p>
        <Button
          variant="outline"
          onClick={advance}
          loading={isAdvancing}
          data-testid="btn-skip-integrations"
        >
          {isAdvancing ? 'Saving…' : 'Skip for now'}
          {!isAdvancing && <ArrowRight className="ml-2 size-4" aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}
