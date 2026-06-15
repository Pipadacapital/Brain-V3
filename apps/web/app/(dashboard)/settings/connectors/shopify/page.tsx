import { Suspense } from 'react';
import { ShopifyCallbackView } from '@/components/connectors/shopify-callback-view';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata = { title: 'Shopify Connection — Brain' };

export default function ShopifyCallbackPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Shopify Connection</h1>
        <p className="text-muted-foreground mt-1">
          Completing your Shopify connection.
        </p>
      </div>
      <Suspense fallback={<Skeleton className="h-48 w-full" />}>
        <ShopifyCallbackView />
      </Suspense>
    </div>
  );
}
