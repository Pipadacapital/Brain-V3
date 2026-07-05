'use client';

/**
 * ProductsContent — Products tab "What sells, and how well?".
 *
 * The per-SKU product leaderboard over the Silver order-line mart. Reuses the existing
 * useTopProducts hook + the TopProductsCard leaderboard component — NO new BFF routes,
 * hooks, or contract changes (P1).
 *
 * Layout: TabShell (header + permanent "?" explainer + a TimeframeBadge trust row) →
 * a summary KPI row derived honestly from the in-view rows → the TopProductsCard table.
 *
 * DISCIPLINE:
 *   - line GMV is a bigint minor-unit string → formatMoneyDisplay(minorStr, ccy). Never /100.
 *   - units / order_count are bigint strings → BigInt() summed for the in-view totals.
 *   - Honest states: 'no_data' → the leaderboard renders its own EmptyState; the KPI row and
 *     trust badges are omitted (never a fabricated 0). The endpoint carries NO generated_at,
 *     so we surface its from→to window via TimeframeBadge rather than a fabricated freshness.
 *   - data_source='synthetic' (dev) → a SyntheticBadge, never silently presented as live.
 *   - The endpoint returns no `category` field, so no category column is fabricated.
 *   - The hook is keyed identically to TopProductsCard's call ({ limit: 10 }) → react-query
 *     shares the single cached query, so reading it here for the header costs no extra fetch.
 */

import Link from 'next/link';
import { LayoutGrid, ChevronRight } from 'lucide-react';
import { TabShell } from '@/components/ui/tab-shell';
import { TimeframeBadge } from '@/components/ui/timeframe-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { TopProductsCard } from '@/components/analytics/top-products-card';
import { Treemap } from '@/components/analytics/treemap';
import { useTopProducts, useProductCategories } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';

const TOP_N = 10;

const EXPLAINER = {
  title: 'Products — What sells, and how well?',
  description:
    'The product leaderboard: which products drive units, orders, and sales value over the recent window.',
  sections: [
    {
      heading: 'How to read this page',
      body: 'Products are ranked by their sales value (quantity × price across order lines) over the window. The summary tiles total only the products currently in view (the top ' +
        TOP_N +
        '), not the whole catalogue — so they describe the leaderboard, not brand-wide sales.',
    },
    {
      heading: 'Revenue by product + drill-in',
      body: 'The treemap sizes each product by its share of revenue. Click any product to open its detail view — the views → add-to-cart → purchase funnel, conversion and return rates, and frequently-bought-together partners.',
    },
  ],
  metrics: [
    {
      name: 'Line GMV',
      definition: 'The gross sales value of a product across orders (quantity × price), before refunds and costs.',
      howComputed: 'Summed per product from your order line items over the window.',
    },
    {
      name: 'Units',
      definition: 'Total quantity of the product sold across all orders in the window.',
    },
    {
      name: 'Orders',
      definition: 'Distinct orders that contained the product in the window.',
    },
  ],
  refreshCadence: 'Recalculated roughly every 15 minutes.',
  sources: ['Order line items from your connected store'],
};

function sumMinor(values: string[]): string {
  return values.reduce((acc, v) => acc + BigInt(v), 0n).toString();
}

function sumCount(values: string[]): string {
  return Number(values.reduce((acc, v) => acc + BigInt(v), 0n)).toLocaleString('en-IN');
}

/**
 * RevenueByProduct — a category Treemap (P3 primitive) over the product-revenue rollup
 * (gold_product_detail), where each cell's AREA is the product's share of revenue. The mart has
 * no category dimension yet, so the honest granularity is the product (named "Revenue by product").
 *
 * Each product is a drill-in target: the legend below the treemap links to /analytics/products/[id]
 * (keyed on the canonical product_id the detail mart is keyed on). The Treemap renders its own
 * loading / honest-empty states; we add the click affordance only when there is data.
 */
function RevenueByProduct() {
  const { data, isLoading } = useProductCategories({ limit: 50 });
  const hasData = data?.state === 'has_data';
  const nodes = hasData ? data.nodes : [];
  // Per-product currency, never blended — use the first node's currency for the value formatter.
  const ccy = (nodes.find((n) => n.currency_code)?.currency_code ?? 'INR') as CurrencyCode;

  const items = nodes.map((n) => ({
    id: n.product_id,
    label: n.product_title ?? n.product_id,
    // value drives the cell area; minor units as a number keeps the share exact for layout.
    value: Number(BigInt(n.revenue_minor)),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LayoutGrid className="h-4 w-4" /> Revenue by product
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Treemap
          items={items}
          isLoading={isLoading}
          width={960}
          height={360}
          className="w-full"
          caption="Revenue by product — each cell's area is its share of revenue"
          valueFormat={(v) => formatMoneyDisplay(String(Math.round(v)), ccy)}
          data-testid="products-revenue-treemap"
        />

        {/* Click-to-drill affordance — the treemap is decorative for navigation, so the product
            links (keyed on product_id) carry the route. Omitted when there is no data. */}
        {hasData && nodes.length > 0 && (
          <ul
            aria-label="Open a product's detail view"
            className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3"
          >
            {nodes.map((n) => (
              <li key={n.product_id}>
                <Link
                  href={`/analytics/products/${encodeURIComponent(n.product_id)}`}
                  className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"
                  data-testid="products-treemap-link"
                >
                  <span className="truncate">{n.product_title ?? n.product_id}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums text-muted-foreground">
                      {n.currency_code ? formatMoneyDisplay(n.revenue_minor, n.currency_code as CurrencyCode) : '—'}
                    </span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function ProductsContent() {
  // Same query key as TopProductsCard ({ limit: 10 }) → react-query serves both from one
  // cached read. We use it only to drive the header trust row + the in-view summary tiles.
  const { data } = useTopProducts({ limit: TOP_N });

  const hasData = data?.state === 'has_data';
  const products = hasData ? data.products : [];
  const ccy = (hasData ? data.currency_code : 'INR') as CurrencyCode;
  const isSynthetic = hasData && data.data_source === 'synthetic';

  return (
    <TabShell
      title="Products"
      description="What sells, and how well?"
      explainer={EXPLAINER}
      freshness={
        hasData ? (
          <span className="flex flex-wrap items-center gap-2">
            <TimeframeBadge
              mode="range"
              label="Window"
              start={data.from}
              end={data.to}
              data-testid="products-timeframe"
            />
            {isSynthetic && (
              <SyntheticBadge
                data-testid="products-synthetic-badge"
                reason="These product figures come from sample data used during setup — connect a live store to replace them."
              />
            )}
          </span>
        ) : undefined
      }
    >
      {/* In-view summary — derived strictly from the leaderboard rows shown below (honest:
          labelled "in view", never implied to be the whole catalogue). Omitted when empty. */}
      {hasData && products.length > 0 && (
        <section aria-label="Top products summary" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile
            label="Products in view"
            help="How many products the leaderboard below is currently showing."
            value={products.length.toLocaleString('en-IN')}
            sublabel={`top ${TOP_N} by sales value`}
            data-testid="products-kpi-skus"
          />
          <KpiTile
            label="Units in view"
            help="Total items sold across the products shown in the leaderboard."
            value={sumCount(products.map((p) => p.units))}
            sublabel="across the leaderboard"
            data-testid="products-kpi-units"
          />
          <KpiTile
            label="Sales value in view"
            help="The combined sales value (quantity × price, before refunds) of the products shown below."
            value={formatMoneyDisplay(sumMinor(products.map((p) => p.line_gmv_minor)), ccy)}
            sublabel="across the leaderboard"
            data-testid="products-kpi-gmv"
          />
        </section>
      )}

      {/* Revenue-share Treemap + per-product drill-in to /analytics/products/[id] (P3). */}
      <RevenueByProduct />

      {/* The leaderboard table — reuses the existing TopProductsCard (its own loading /
          error / no_data states, including the honest EmptyState when no products exist). */}
      <TopProductsCard />
    </TabShell>
  );
}
