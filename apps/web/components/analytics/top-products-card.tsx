'use client';

/**
 * TopProductsCard — top SKUs by line GMV over the last 90 days (feat-shopify-order-depth).
 *
 * Reads the Silver order-line mart through the metric-engine seam (useTopProducts → BFF →
 * computeTopProducts). This is the product-level analytics the order-depth capture unlocks.
 *
 * DISCIPLINE:
 *   - line GMV is a bigint minor-unit string → formatMoneyDisplay(minorStr, ccy). Never /100.
 *   - units / order_count are bigint strings → BigInt() parsed for display.
 *   - Honest states: loading → skeleton; error → ErrorCard; 'no_data' → EmptyState; never a fake 0.
 *   - data_source='synthetic' (dev) → a Synthetic badge, never silently presented as live.
 */
import { Package } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { useTopProducts } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';

function formatCount(n: string): string {
  return Number(BigInt(n)).toLocaleString('en-IN');
}

export function TopProductsCard() {
  const { data, isLoading, error } = useTopProducts({ limit: 10 });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2"><Package className="h-4 w-4" /> Top products</CardTitle>
        {data?.state === 'has_data' && data.data_source === 'synthetic' && (
          <SyntheticBadge data-testid="top-products-synthetic-badge" />
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading && (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        )}

        {!isLoading && error && <div className="p-4"><ErrorCard error={error} /></div>}

        {!isLoading && !error && data?.state === 'no_data' && (
          <div className="p-4">
            <EmptyState
              icon={<Package className="h-6 w-6" />}
              title="No product data yet"
              description="Top products appear once orders with line items flow through ingest into the Silver tier."
            />
          </div>
        )}

        {!isLoading && !error && data?.state === 'has_data' && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">#</th>
                  <th className="px-4 py-2 font-medium">Product</th>
                  <th className="px-4 py-2 text-right font-medium">Units</th>
                  <th className="px-4 py-2 text-right font-medium">Orders</th>
                  <th className="px-4 py-2 text-right font-medium">Line GMV</th>
                </tr>
              </thead>
              <tbody>
                {data.products.map((p, i) => (
                  <tr key={p.sku} className="border-b last:border-0">
                    <td className="px-4 py-2 text-muted-foreground">{i + 1}</td>
                    <td className="px-4 py-2">
                      <div className="font-medium">{p.title ?? p.sku}</div>
                      <div className="font-mono text-xs text-muted-foreground">{p.sku}</div>
                    </td>
                    <td className="px-4 py-2 text-right">{formatCount(p.units)}</td>
                    <td className="px-4 py-2 text-right">{formatCount(p.order_count)}</td>
                    <td className="px-4 py-2 text-right font-medium">
                      {formatMoneyDisplay(p.line_gmv_minor, data.currency_code as CurrencyCode)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
