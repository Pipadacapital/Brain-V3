'use client';

/**
 * OrdersListCard — paginated list of latest canonical-state orders.
 *
 * Reads the Silver order spine (mv_silver_order_state, gross value from mv_silver_order_line) via
 * useOrdersList — the SAME canonical records the Data browser shows, so the two agree. The per-order
 * drill-down was removed (it read Bronze); order_id is plain text. Offset pagination with flicker-free
 * prev/next (placeholderData keeps the prior page).
 *
 * DISCIPLINE:
 *   - amount is a bigint minor-unit string → formatMoneyDisplay(minorStr, ccy). Never /100.
 *   - Honest states: loading → skeleton; error → ErrorCard; 'no_data' → EmptyState; never a fake 0.
 */
import { useState } from 'react';
import { ShoppingCart, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrdersList } from '@/lib/hooks/use-analytics';
import { humanize } from '@/lib/format/humanize';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';

const PAGE_SIZE = 20;

export function OrdersListCard() {
  const [page, setPage] = useState(1);
  const { data, isLoading, error, isPlaceholderData } = useOrdersList(page, PAGE_SIZE);

  const total = data && data.state !== undefined ? Number(BigInt(data.total)) : 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2"><ShoppingCart className="h-4 w-4" /> Orders</CardTitle>
        {total > 0 && (
          <span className="text-xs text-muted-foreground">
            {total.toLocaleString('en-IN')} total · page {page}/{lastPage}
          </span>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading && (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        )}

        {!isLoading && error && <div className="p-4"><ErrorCard error={error} /></div>}

        {!isLoading && !error && data?.state === 'no_data' && (
          <div className="p-4">
            <EmptyState
              icon={<ShoppingCart className="h-6 w-6" />}
              title="No orders yet"
              description="Orders appear here as they flow through ingest. Connect a store and run a sync to populate this list."
            />
          </div>
        )}

        {!isLoading && !error && data?.state === 'has_data' && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Order</th>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className={isPlaceholderData ? 'opacity-60' : ''}>
                  {data.orders.map((o) => (
                    <tr key={o.order_id} className="border-b last:border-0 hover:bg-accent/50">
                      <td className="px-4 py-2">
                        {/* Per-order drill-down removed — the Data page shows the full record + detail modal. */}
                        <span className="font-mono text-xs font-medium">{o.order_id}</span>
                        {o.has_depth && (
                          <Badge
                            variant="outline"
                            className="ml-2 text-[10px]"
                            title="Full order detail (line items, discounts, taxes) was captured for this order"
                          >
                            full detail
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{new Date(o.occurred_at).toLocaleDateString('en-IN')}</td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-1">
                          {o.payment_method && <Badge variant="secondary" className="text-[10px]">{o.payment_method.toUpperCase()}</Badge>}
                          {o.financial_status && <Badge className="text-[10px]">{humanize(o.financial_status)}</Badge>}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right font-medium">
                        {formatMoneyDisplay(o.amount_minor, o.currency_code as CurrencyCode)}
                        {/* FX convenience view: approximate amount in the brand's primary currency
                            (latest rate, display-only). Native amount above stays authoritative. */}
                        {o.amount_in_primary_minor && data.primary_currency && (
                          <div
                            className="text-[10px] font-normal text-muted-foreground"
                            title="Approximate — converted to your primary currency at the latest exchange rate"
                          >
                            ≈ {formatMoneyDisplay(o.amount_in_primary_minor, data.primary_currency as CurrencyCode)} (approx)
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between gap-2 border-t p-3">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" /> Prev
              </button>
              <span className="text-xs text-muted-foreground">Page {page} of {lastPage}</span>
              <button
                type="button"
                onClick={() => setPage((p) => (p < lastPage ? p + 1 : p))}
                disabled={page >= lastPage}
                className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm hover:bg-accent disabled:opacity-40"
              >
                Next <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
