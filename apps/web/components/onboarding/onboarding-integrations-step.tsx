'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, CheckCircle, XCircle, Plug, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { sessionApi } from '@/lib/api/client';
import { useConnectorList, useShopifyInstallUrl } from '@/lib/hooks/use-connectors';
import { toast } from '@/components/ui/toaster';
import type { ConnectorListItem, ConnectorStatus } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { BffApiError, userFacingMessage } from '@/lib/api/client';

/**
 * Step 3 of 4 — Integration selection.
 *
 * - Shopify: connect-now (OAuth) or skip.
 * - Meta Ads, Google Ads: coming soon (disabled — never shown as wizard step).
 * - Pixel: NOT in the wizard (per MA-10, stays in settings/pixel).
 * - OAuth failure leaves source Disconnected with retry — does NOT block the wizard.
 * - "Skip For Now" → advance onboarding_status to integration_selected → Step 4.
 */

const STATUS_CONFIG: Record<
  ConnectorStatus,
  { icon: React.ElementType; label: string; textClass: string }
> = {
  connected: {
    icon: CheckCircle,
    label: 'Connected',
    textClass: 'text-green-700',
  },
  disconnected: {
    icon: Plug,
    label: 'Disconnected',
    textClass: 'text-muted-foreground',
  },
  error: {
    icon: XCircle,
    label: 'Error — retry to reconnect',
    textClass: 'text-red-700',
  },
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

  return (
    <Card data-testid={`connector-card-${item.provider}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              {item.display_name}
              {item.coming_soon && (
                <Badge variant="outline" className="text-xs">
                  Coming Soon
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="mt-1">{item.description}</CardDescription>
          </div>
          {/* Status indicator — never colour-only (a11y) */}
          {isConnected && status && (
            <span
              role="status"
              aria-label={`${item.display_name} status: ${STATUS_CONFIG[status].label}`}
              className={cn(
                'flex items-center gap-1.5 text-sm font-medium shrink-0',
                STATUS_CONFIG[status].textClass,
              )}
            >
              {(() => {
                const Icon = STATUS_CONFIG[status].icon;
                return <Icon className="h-4 w-4" aria-hidden="true" />;
              })()}
              <span>{STATUS_CONFIG[status].label}</span>
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {connectError && (
          <p className="mb-3 text-xs text-destructive" role="alert">
            {connectError} — you can skip and connect later.
          </p>
        )}
        {item.coming_soon ? (
          <Button
            variant="outline"
            disabled
            aria-label={`${item.display_name} — Coming Soon`}
            aria-disabled="true"
            className="cursor-not-allowed"
          >
            Coming Soon
          </Button>
        ) : isConnected ? (
          <div className="flex items-center gap-3">
            {item.instance?.shop_domain && (
              <p className="text-sm text-muted-foreground">{item.instance.shop_domain}</p>
            )}
            <Button
              size="sm"
              onClick={onAdvance}
              data-testid={`btn-continue-after-connect-${item.provider}`}
            >
              Continue
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {item.provider === 'shopify' && (
              <div className="space-y-1">
                <label htmlFor={`shop-${item.provider}`} className="text-xs text-muted-foreground">
                  Your Shopify store domain
                </label>
                <Input
                  id={`shop-${item.provider}`}
                  value={shopDomain}
                  onChange={(e) => setShopDomain(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleConnect();
                  }}
                  placeholder="my-store.myshopify.com"
                  autoComplete="off"
                  data-testid={`input-shop-${item.provider}`}
                />
              </div>
            )}
            <Button
              onClick={handleConnect}
              disabled={isConnecting || (item.provider === 'shopify' && !shopDomain.trim())}
              data-testid={`btn-connect-${item.provider}`}
            >
              {isConnecting && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {isConnecting ? 'Connecting…' : `Connect ${item.display_name}`}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
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
      <div className="space-y-4" aria-busy="true" aria-label="Loading integrations…">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-36 w-full rounded-lg bg-muted animate-pulse" aria-hidden="true" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <ErrorCard
        error={error}
        retry={refetch}
      />
    );
  }

  // Pixel is NOT in the wizard (MA-10 / plan §F-2).
  // The connector API returns shopify | meta | google — all valid wizard entries.
  const wizardConnectors = data ?? [];

  return (
    <div className="space-y-6">
      {advanceError && (
        <p className="text-sm text-destructive" role="alert">
          {advanceError}
        </p>
      )}

      <div className="space-y-4">
        {wizardConnectors.map((item) => (
          <ConnectorWizardCard key={item.provider} item={item} onAdvance={advance} />
        ))}
      </div>

      <div className="flex items-center justify-between border-t pt-4">
        <p className="text-sm text-muted-foreground">
          You can always connect integrations later from Settings.
        </p>
        <Button
          variant="outline"
          onClick={advance}
          disabled={isAdvancing}
          data-testid="btn-skip-integrations"
        >
          {isAdvancing && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {isAdvancing ? 'Saving…' : 'Skip for now'}
          {!isAdvancing && <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}
