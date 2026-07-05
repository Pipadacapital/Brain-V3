'use client';

/**
 * ProductDetailContent — one product's storefront performance (P3 drill-down).
 *
 * Reads the pre-materialized Gold marts through the analytics seam:
 *   - useProductDetail   → gold_product_detail: views → add_to_cart → purchases → revenue,
 *     returns, and the two conversion rates (add-to-cart / purchase).
 *   - useProductAffinity → gold_product_affinity: frequently-bought-together partners.
 *
 * DISCIPLINE:
 *   - revenue is a bigint minor-unit string → formatMoneyDisplay(minorStr, ccy). Never /100.
 *   - views / add_to_cart / purchases / return_count are bigint strings → BigInt() parsed.
 *   - Rates are 2dp percentage strings from the mart → rendered with a '%' suffix verbatim
 *     (never re-derived as a float). return_rate is null when purchases = 0 → honest '—'.
 *   - Honest states: loading → skeleton; error → ErrorCard; 'not_found' → EmptyState; the
 *     funnel/affinity each render their own EmptyState when there is nothing to show. Never
 *     a fabricated 0 or empty chart presented as success.
 *   - currency_code is null for a views/cart-only product (0 purchases) → revenue shown as '—'.
 */

import Link from 'next/link';
import { ArrowLeft, Package, Workflow, Eye, ShoppingCart, Receipt } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useProductDetail, useProductAffinity } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';

function formatCount(n: string): string {
  return Number(BigInt(n)).toLocaleString('en-IN');
}

function pct(rate: string | null): string {
  return rate === null ? '—' : `${rate}%`;
}

/**
 * FunnelBars — views → add-to-cart → purchases as proportional stepped bars.
 * Widths are relative to the funnel head (views); each stage prints its absolute count and
 * the conversion rate into it. No heavy dep — plain divs + an sr-only table carry the data.
 */
function FunnelBars({
  views,
  addToCart,
  purchases,
  atcRate,
  purchaseRate,
}: {
  views: string;
  addToCart: string;
  purchases: string;
  atcRate: string;
  purchaseRate: string;
}) {
  const head = Number(BigInt(views));
  const stages = [
    { key: 'views', label: 'Views', count: views, rate: null as string | null, icon: <Eye className="h-4 w-4" /> },
    { key: 'atc', label: 'Add to cart', count: addToCart, rate: atcRate, icon: <ShoppingCart className="h-4 w-4" /> },
    { key: 'purchase', label: 'Purchases', count: purchases, rate: purchaseRate, icon: <Receipt className="h-4 w-4" /> },
  ];

  if (head === 0) {
    return (
      <EmptyState
        icon={<Workflow className="h-6 w-6" />}
        title="No storefront views yet"
        description="The views → add-to-cart → purchase funnel appears once the Brain Pixel records views for this product."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* sr-only source of truth — colour/width is never the sole carrier */}
      <table className="sr-only" aria-label="Product funnel data table">
        <caption>Views to add-to-cart to purchase funnel, with the conversion rate into each stage</caption>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Count</th>
            <th scope="col">Conversion into stage</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s) => (
            <tr key={s.key}>
              <td>{s.label}</td>
              <td>{formatCount(s.count)}</td>
              <td>{pct(s.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div aria-hidden="true" className="space-y-3">
        {stages.map((s, i) => {
          const count = Number(BigInt(s.count));
          const widthPct = head > 0 ? Math.max((count / head) * 100, count > 0 ? 4 : 0) : 0;
          return (
            <div key={s.key} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  {s.icon}
                  {s.label}
                </span>
                <span className="tabular-nums">
                  {formatCount(s.count)}
                  {s.rate !== null && (
                    <span className="ml-2 text-xs text-muted-foreground">{pct(s.rate)} of views</span>
                  )}
                </span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded bg-muted">
                <div
                  className="h-full rounded"
                  style={{ width: `${widthPct}%`, backgroundColor: `hsl(var(--chart-${i + 1}))` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ProductDetailContent({ productId }: { productId: string }) {
  const { data, isLoading, error } = useProductDetail(productId);
  const affinity = useProductAffinity(productId, { limit: 10 });

  const back = (
    <Link
      href="/analytics/products"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" /> Products
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
          title="Product not found"
          description={`We haven't recorded any activity for product ${productId} yet. It appears here once its views and orders start flowing in.`}
        />
      </div>
    );
  }

  const d = data.detail;
  const ccy = (d.currency_code ?? 'INR') as CurrencyCode;
  const hasRevenue = d.currency_code !== null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={back}
        title={d.product_title ?? d.product_id}
        description={<span className="font-mono text-xs">{d.product_id}</span>}
        meta={<FreshnessBadge timestamp={d.updated_at} data-testid="product-detail-freshness" />}
      />

      {/* Headline funnel + revenue KPIs — each honest (counts never fabricated; revenue '—' when
          the product has no purchases, i.e. no currency). */}
      <section
        aria-label="Product performance summary"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        <KpiTile
          label="Views"
          help="How many times shoppers viewed this product's page."
          value={formatCount(d.views)}
          data-testid="product-kpi-views"
        />
        <KpiTile
          label="Add to cart"
          help="How many times shoppers added this product to their cart."
          value={formatCount(d.add_to_cart)}
          sublabel={`${pct(d.add_to_cart_rate)} of views`}
          data-testid="product-kpi-atc"
        />
        <KpiTile
          label="Purchases"
          help="How many times this product was bought."
          value={formatCount(d.purchases)}
          sublabel={`${pct(d.purchase_rate)} of views`}
          data-testid="product-kpi-purchases"
        />
        <KpiTile
          label="Revenue"
          help="Total money from purchases of this product."
          value={hasRevenue ? formatMoneyDisplay(d.revenue_minor, ccy) : null}
          sublabel={hasRevenue ? ccy : 'no purchases yet'}
          data-testid="product-kpi-revenue"
        />
        <KpiTile
          label="Returns"
          help="How many purchases of this product were returned."
          value={formatCount(d.return_count)}
          sublabel={d.return_rate === null ? 'no purchases yet' : `${pct(d.return_rate)} of purchases`}
          data-testid="product-kpi-returns"
        />
      </section>

      {/* Conversion funnel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Workflow className="h-4 w-4" /> Storefront funnel
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FunnelBars
            views={d.views}
            addToCart={d.add_to_cart}
            purchases={d.purchases}
            atcRate={d.add_to_cart_rate}
            purchaseRate={d.purchase_rate}
          />
        </CardContent>
      </Card>

      {/* Frequently bought together (affinity) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-4 w-4" /> Frequently bought together
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {affinity.isLoading && (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          )}

          {!affinity.isLoading && affinity.error && (
            <div className="p-4">
              <ErrorCard error={affinity.error} />
            </div>
          )}

          {!affinity.isLoading && !affinity.error && affinity.data?.state === 'no_data' && (
            <div className="p-4">
              <EmptyState
                icon={<Package className="h-6 w-6" />}
                title="No co-purchase partners yet"
                description="Frequently-bought-together pairs appear once this product is purchased alongside others in enough orders."
              />
            </div>
          )}

          {!affinity.isLoading && !affinity.error && affinity.data?.state === 'has_data' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Partner product</th>
                    <th className="px-4 py-2 text-right font-medium">Co-purchases</th>
                    <th
                      className="px-4 py-2 text-right font-medium"
                      title="The share of orders containing this product that also contained the partner product."
                    >
                      Bought together %
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {affinity.data.pairs.map((p) => (
                    <tr key={p.product_b} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        <Link
                          href={`/analytics/products/${encodeURIComponent(p.product_b)}`}
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          {p.product_b}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatCount(p.co_purchase_count)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{p.support_pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
