'use client';

import { useState } from 'react';
import { Loader2, CheckCircle, XCircle, Plug } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useConnectorList, useShopifyInstallUrl, useDisconnectConnector } from '@/lib/hooks/use-connectors';
import { BffApiError } from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';
import type { ConnectorListItem, ConnectorStatus } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { BackfillControl } from '@/components/connectors/backfill-control';
import { SyncNowControl } from '@/components/connectors/sync-now-control';

/**
 * A11y: connector status is never colour-only — always icon + label.
 * Meta + Google = disabled "Coming Soon" buttons. Zero backend calls for those.
 * Per arch plan §5.1: GET /api/v1/connectors returns shopify + Meta/Google as coming_soon flags.
 */

const STATUS_CONFIG: Record<
  ConnectorStatus,
  { icon: React.ElementType; label: string; textClass: string }
> = {
  connected: {
    icon: CheckCircle,
    label: 'Connected',
    textClass: 'text-status-green-700',
  },
  disconnected: {
    icon: Plug,
    label: 'Disconnected',
    textClass: 'text-muted-foreground',
  },
  error: {
    icon: XCircle,
    label: 'Error',
    textClass: 'text-status-red-700',
  },
};

function ConnectorCard({ item }: { item: ConnectorListItem }) {
  const { mutate: getShopifyUrl, isPending: isConnecting } = useShopifyInstallUrl();
  const { mutate: disconnect, isPending: isDisconnecting } = useDisconnectConnector();
  const [shopDomain, setShopDomain] = useState('');

  function handleConnect() {
    if (item.provider !== 'shopify') return;
    // Shopify OAuth needs the store domain; the backend 400s without ?shop=.
    const shop = shopDomain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!shop) {
      toast({ title: 'Store domain required', description: 'Enter your Shopify store domain (e.g. my-store.myshopify.com).', variant: 'destructive' });
      return;
    }
    getShopifyUrl(shop, {
      onSuccess: (data) => {
        // Redirect to Shopify OAuth — real install URL from BFF
        window.location.href = data.install_url;
      },
      onError: () => {
        toast({ title: 'Error', description: 'Could not start Shopify connection.', variant: 'destructive' });
      },
    });
  }

  function handleDisconnect() {
    if (!item.instance) return;
    disconnect(item.instance.id, {
      onSuccess: () => {
        toast({ title: 'Disconnected', description: `${item.display_name} has been disconnected.` });
      },
    });
  }

  const isConnected = !!item.instance;
  const status = item.instance?.status;

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
          {/* Connection status — icon + label, never colour-only */}
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
              {STATUS_CONFIG[status].label}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {item.coming_soon ? (
          <Button
            variant="outline"
            disabled
            aria-label={`${item.display_name} — Coming Soon`}
            aria-disabled="true"
            className="cursor-not-allowed"
            title="This integration is coming soon"
          >
            Coming Soon
          </Button>
        ) : isConnected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              {item.instance?.shop_domain && (
                <p className="text-sm text-muted-foreground">{item.instance.shop_domain}</p>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
                disabled={isDisconnecting}
                data-testid={`btn-disconnect-${item.provider}`}
              >
                {isDisconnecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>
            {/* Backfill control — visible to all roles, trigger gated to brand_admin+ (D-15) */}
            {item.provider === 'shopify' && item.instance?.id && (
              <BackfillControl
                connectorId={item.instance.id}
                className="pt-2 border-t border-border"
              />
            )}
            {/* Sync now — on-demand incremental re-pull. Status visible to all roles;
                trigger gated to brand_admin+ (hidden for manager/analyst). */}
            {item.instance?.id && (
              <SyncNowControl
                connectorId={item.instance.id}
                className="pt-2 border-t border-border"
              />
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {item.provider === 'shopify' && (
              <Input
                value={shopDomain}
                onChange={(e) => setShopDomain(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConnect(); }}
                placeholder="my-store.myshopify.com"
                aria-label="Shopify store domain"
                autoComplete="off"
                data-testid={`input-shop-${item.provider}`}
              />
            )}
            <Button
              onClick={handleConnect}
              disabled={isConnecting || (item.provider === 'shopify' && !shopDomain.trim())}
              data-testid={`btn-connect-${item.provider}`}
            >
              {isConnecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {isConnecting ? 'Connecting…' : `Connect ${item.display_name}`}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ConnectorsList() {
  const { data, isLoading, error, refetch } = useConnectorList();

  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading connectors…">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-36 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    if (error instanceof BffApiError && error.status === 403) {
      return (
        <EmptyState
          title="Setup required"
          description="Complete onboarding to access connectors."
          icon={<Plug className="h-8 w-8" />}
          action={
            <Link href="/workspace/new" className="text-sm text-primary underline-offset-4 hover:underline">
              Continue setup
            </Link>
          }
        />
      );
    }
    return <ErrorCard error={error} retry={refetch} />;
  }

  if (!data || data.length === 0) {
    return (
      <EmptyState
        title="No Data Yet"
        description="No integrations are available."
        icon={<Plug className="h-8 w-8" />}
      />
    );
  }

  return (
    <div className="space-y-4">
      {data.map((item) => (
        <ConnectorCard key={item.provider} item={item} />
      ))}
    </div>
  );
}
