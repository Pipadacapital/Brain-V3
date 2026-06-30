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

import { TabShell } from '@/components/ui/tab-shell';
import { TimeframeBadge } from '@/components/ui/timeframe-badge';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { TopProductsCard } from '@/components/analytics/top-products-card';
import { useTopProducts } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';

const TOP_N = 10;

const EXPLAINER = {
  title: 'Products — What sells, and how well?',
  description:
    'The product leaderboard: which SKUs drive units, orders, and line GMV over the recent window.',
  sections: [
    {
      heading: 'How to read this page',
      body: 'Products are ranked by line GMV (the gross value of that SKU’s order lines) over the window. The summary tiles total only the SKUs currently in view (the top ' +
        TOP_N +
        '), not the whole catalogue — so they describe the leaderboard, not brand-wide sales.',
    },
  ],
  metrics: [
    {
      name: 'Line GMV',
      definition: 'Gross merchandise value of a SKU’s order lines (quantity × price), in minor currency units.',
      howComputed: 'Summed per SKU from the Silver order-line mart over the window.',
    },
    {
      name: 'Units',
      definition: 'Total quantity of the SKU sold across all orders in the window.',
    },
    {
      name: 'Orders',
      definition: 'Distinct orders that contained the SKU in the window.',
    },
  ],
  refreshCadence: 'Recomputed each Silver→Gold refresh (≈ every 15 min).',
  sources: ['Silver order-line mart (feat-shopify-order-depth)'],
};

function sumMinor(values: string[]): string {
  return values.reduce((acc, v) => acc + BigInt(v), 0n).toString();
}

function sumCount(values: string[]): string {
  return Number(values.reduce((acc, v) => acc + BigInt(v), 0n)).toLocaleString('en-IN');
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
                reason="Product line items are synthetic in dev (real shape, synthetic source) until a live commerce source is connected."
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
            label="SKUs in view"
            value={products.length.toLocaleString('en-IN')}
            sublabel={`top ${TOP_N} by line GMV`}
            data-testid="products-kpi-skus"
          />
          <KpiTile
            label="Units in view"
            value={sumCount(products.map((p) => p.units))}
            sublabel="across the leaderboard"
            data-testid="products-kpi-units"
          />
          <KpiTile
            label="Line GMV in view"
            value={formatMoneyDisplay(sumMinor(products.map((p) => p.line_gmv_minor)), ccy)}
            sublabel="across the leaderboard"
            data-testid="products-kpi-gmv"
          />
        </section>
      )}

      {/* The leaderboard table — reuses the existing TopProductsCard (its own loading /
          error / no_data states, including the honest EmptyState when no products exist). */}
      <TopProductsCard />
    </TabShell>
  );
}
