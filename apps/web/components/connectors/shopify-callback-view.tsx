'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useConnectorList } from '@/lib/hooks/use-connectors';

/**
 * ShopifyCallbackView — shown after Shopify OAuth redirects back to the app.
 * The actual HMAC validation and token storage happens in the BFF/backend.
 * This page reads query params and shows the result state.
 * The connector status is read from the real BFF; no fake success.
 */
export function ShopifyCallbackView() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const error = searchParams.get('error');
  const shop = searchParams.get('shop');

  const { data: connectors, isLoading, refetch } = useConnectorList();

  const shopifyConnector = connectors?.find((c) => c.provider === 'shopify');
  const isConnected = shopifyConnector?.instance?.status === 'connected';
  const hasError = !!error || shopifyConnector?.instance?.status === 'error';

  if (error) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <XCircle className="h-10 w-10 text-status-red-700" aria-hidden="true" />
            <h2 className="text-base font-semibold text-status-red-700">Connection failed</h2>
            <p className="text-sm text-muted-foreground max-w-xs">
              {error === 'access_denied'
                ? 'You denied access to the Shopify store. Please try again.'
                : `Connection error: ${error}`}
            </p>
            <Button variant="outline" onClick={() => router.push('/settings/connectors')}>
              Back to connectors
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              Verifying connection{shop ? ` to ${shop}` : ''}…
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isConnected) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <CheckCircle className="h-10 w-10 text-status-green-700" aria-hidden="true" />
            <h2 className="text-base font-semibold">Shopify connected</h2>
            {shopifyConnector?.instance?.shop_domain && (
              <p className="text-sm text-muted-foreground">
                {shopifyConnector.instance.shop_domain}
              </p>
            )}
            <Button onClick={() => router.push('/dashboard')}>Go to dashboard</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Sync state shown
  return (
    <Card>
      <CardContent className="py-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Connection in progress…</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Refresh status
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
