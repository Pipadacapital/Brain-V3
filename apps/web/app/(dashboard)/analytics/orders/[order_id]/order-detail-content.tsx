'use client';

/**
 * OrderDetailContent — one order's captured economic breakdown (feat-shopify-order-depth).
 *
 * Reads the order's composition from Bronze (the source-of-truth layer) via useOrderDetail:
 * line items, tax, shipping, discounts and refunds. This is the drill-down for the depth the
 * Shopify mapper now captures.
 *
 * DISCIPLINE:
 *   - All money is a bigint minor-unit string → formatMoneyDisplay(minorStr, ccy). Never /100.
 *   - Honest states: loading → skeleton; error → ErrorCard; 'not_found' → EmptyState; never a fake 0.
 *   - has_depth=false (legacy/flat order) shows the order header + an honest "no breakdown captured".
 */
import Link from 'next/link';
import { ArrowLeft, Package, Receipt, RotateCcw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrderDetail } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';

function Money({ minor, ccy }: { minor: string | null; ccy: CurrencyCode }) {
  if (minor === null) return <span className="text-muted-foreground">—</span>;
  return <span>{formatMoneyDisplay(minor, ccy)}</span>;
}

export function OrderDetailContent({ orderId }: { orderId: string }) {
  const { data, isLoading, error } = useOrderDetail(orderId);

  const back = (
    <Link href="/analytics/orders" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" /> Orders
    </Link>
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        {back}
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        {back}
        <ErrorCard error={error} />
      </div>
    );
  }

  if (!data || data.state === 'not_found') {
    return (
      <div className="space-y-6">
        {back}
        <EmptyState
          icon={<Package className="h-6 w-6" />}
          title="Order not found"
          description={`No captured order with id ${orderId} for this brand yet. Orders appear here once they flow through ingest.`}
        />
      </div>
    );
  }

  const d = data.detail;
  const ccy = d.currency_code as CurrencyCode;

  return (
    <div className="space-y-6">
      {back}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Order {d.order_id}</h1>
          <p className="text-sm text-muted-foreground">
            {new Date(d.occurred_at).toLocaleString('en-IN')} · {ccy}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {d.payment_method && <Badge variant="secondary">{d.payment_method.toUpperCase()}</Badge>}
          {d.financial_status && <Badge>{d.financial_status}</Badge>}
          {d.fulfillment_status && <Badge variant="outline">{d.fulfillment_status}</Badge>}
          {d.cancelled_at && <Badge variant="destructive">cancelled</Badge>}
        </div>
      </div>

      {/* Order total + breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Receipt className="h-4 w-4" /> Order total</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:max-w-md">
            <dt className="text-muted-foreground">Tax</dt>
            <dd className="text-right"><Money minor={d.tax_total_minor} ccy={ccy} /></dd>
            <dt className="text-muted-foreground">Shipping</dt>
            <dd className="text-right"><Money minor={d.shipping_total_minor} ccy={ccy} /></dd>
            <dt className="text-muted-foreground">Discounts</dt>
            <dd className="text-right text-emerald-600"><Money minor={d.discount_total_minor} ccy={ccy} /></dd>
            <dt className="text-muted-foreground">Refunded</dt>
            <dd className="text-right text-amber-600"><Money minor={d.refund_total_minor} ccy={ccy} /></dd>
            <dt className="border-t pt-2 font-medium">Total</dt>
            <dd className="border-t pt-2 text-right font-semibold">{formatMoneyDisplay(d.amount_minor, ccy)}</dd>
          </dl>
        </CardContent>
      </Card>

      {!d.has_depth && (
        <EmptyState
          icon={<Package className="h-6 w-6" />}
          title="No line-item breakdown captured"
          description="This order predates economic-depth capture, or arrived without line items. New orders carry the full breakdown."
        />
      )}

      {/* Line items */}
      {d.line_items.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Package className="h-4 w-4" /> Line items ({d.line_items.length})</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Product</th>
                  <th className="px-4 py-2 font-medium">SKU</th>
                  <th className="px-4 py-2 text-right font-medium">Qty</th>
                  <th className="px-4 py-2 text-right font-medium">Unit</th>
                  <th className="px-4 py-2 text-right font-medium">Line total</th>
                </tr>
              </thead>
              <tbody>
                {d.line_items.map((li, i) => (
                  <tr key={`${li.sku ?? li.product_id ?? 'li'}-${i}`} className="border-b last:border-0">
                    <td className="px-4 py-2">{li.title ?? '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{li.sku ?? '—'}</td>
                    <td className="px-4 py-2 text-right">{li.quantity}</td>
                    <td className="px-4 py-2 text-right"><Money minor={li.unit_price_minor} ccy={ccy} /></td>
                    <td className="px-4 py-2 text-right">{formatMoneyDisplay(li.line_total_minor, ccy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Tax lines */}
      {d.tax_lines.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Tax lines</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {d.tax_lines.map((t, i) => (
                <li key={i} className="flex justify-between">
                  <span className="text-muted-foreground">{t.title ?? 'Tax'}{t.rate != null ? ` (${(t.rate * 100).toFixed(2)}%)` : ''}</span>
                  <Money minor={t.amount_minor} ccy={ccy} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Refunds */}
      {d.refunds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><RotateCcw className="h-4 w-4" /> Refunds ({d.refunds.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {d.refunds.map((r, i) => (
                <li key={r.refund_id ?? i} className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {r.processed_at ? new Date(r.processed_at).toLocaleDateString('en-IN') : 'refund'}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </span>
                  <span className="text-amber-600">{formatMoneyDisplay(r.amount_minor, ccy)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
