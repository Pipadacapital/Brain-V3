'use client';

/**
 * AbandonedCartContent — the cart-recovery surface (Silver tier, Phase H pixel).
 *
 * Reads ONLY via the BFF /api/v1/analytics/abandoned-cart (the metric-engine storefront-abandoned-cart
 * seam over silver_touchpoint, I-ST01) — never StarRocks/SQL directly. Shows, of the sessions that
 * added to cart, how many converted (stitched to an order) vs abandoned, plus the abandonment and
 * recovery rates.
 *
 * Honest states: skeleton (aria-busy), ErrorCard with request_id, and an honest empty state linking
 * to pixel setup — never a fabricated zero. Counts are integer (bigint→string); percentages are 2dp
 * strings from the engine (never re-divided with floats here).
 */

import { useState } from 'react';
import Link from 'next/link';
import { ShoppingCart, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MetricTitle } from '@/components/ui/metric-title';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { DateRangeFilter, initialRange, type DateRange } from '@/components/ui/date-range-filter';
import { useAbandonedCart } from '@/lib/hooks/use-analytics';
import type { AnalyticsAbandonedCartResponse } from '@/lib/api/types';

type AbandonedHasData = Extract<AnalyticsAbandonedCartResponse, { state: 'has_data' }>;

function num(s: string): string {
  return Number(s).toLocaleString('en-IN');
}

function Loading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading cart recovery…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function EmptyCard() {
  return (
    <Card data-testid="abandoned-cart-empty">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <ShoppingCart className="h-8 w-8" />
        </div>
        <div>
          <p className="font-medium text-foreground">No cart activity yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            Cart recovery appears once the Brain Pixel captures add-to-cart events and orders are
            stitched back to those sessions. It builds from the journey touchpoints in the Silver tier.
          </p>
        </div>
        <Link href="/settings/pixel">
          <Button variant="outline" size="sm">
            Set up the Brain Pixel
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

function RecoveryBar({ data }: { data: AbandonedHasData }) {
  const recovered = Math.min(100, Number(data.recovery_rate_pct ?? 0));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          <MetricTitle
            label={`Cart outcomes (${num(data.cart_sessions)} carts)`}
            help="Of the visits where something was added to a cart, how many ended in a purchase versus none."
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-foreground">Went on to buy</span>
          <span className="text-muted-foreground tabular-nums">
            {num(data.converted_sessions)}
            {data.recovery_rate_pct !== null && <span className="ml-2 text-foreground">{data.recovery_rate_pct}%</span>}
          </span>
        </div>
        <div className="h-3 rounded bg-muted overflow-hidden" aria-hidden="true">
          <div className="h-full bg-foreground/70" style={{ width: `${recovered}%` }} />
        </div>
        <div className="flex items-center justify-between text-sm pt-1">
          <span className="text-foreground">Left without buying</span>
          <span className="text-muted-foreground tabular-nums">
            {num(data.abandoned_sessions)}
            {data.abandonment_rate_pct !== null && <span className="ml-2">{data.abandonment_rate_pct}%</span>}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function AbandonedCartContent() {
  const [range, setRange] = useState<DateRange>(() => initialRange());

  const q = useAbandonedCart({ from: range.from, to: range.to });
  const data = q.data;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Abandoned Cart"
        description="Of the visits where something was added to a cart, how many went on to purchase versus left without buying — captured by the Brain Pixel and matched to orders."
        meta={
          <span
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Read from the Silver tier (silver_touchpoint) via the metric-engine storefront-abandoned-cart seam."
          >
            <ShoppingCart className="h-3 w-3" aria-hidden="true" />
            Powered by the Silver tier
          </span>
        }
      />

      <section aria-label="Cart recovery">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">Cart recovery</h2>
          <DateRangeFilter value={range} onChange={setRange} aria-label="Abandoned cart date range" />
        </div>

        {q.isLoading && <Loading />}
        {!q.isLoading && q.error && <ErrorCard error={q.error} retry={q.refetch} />}
        {!q.isLoading && !q.error && data?.state === 'no_data' && <EmptyCard />}
        {!q.isLoading && !q.error && data?.state === 'has_data' && <AbandonedCartData data={data} />}
      </section>
    </div>
  );
}

function AbandonedCartData({ data }: { data: AbandonedHasData }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Abandoned carts"
          help="Carts where items were added but no purchase was completed."
          value={num(data.abandoned_sessions)}
          sublabel={`${data.from} → ${data.to}`}
        />
        <KpiTile
          label="Abandonment rate"
          help="Of all carts started, the share that were left without a purchase."
          value={data.abandonment_rate_pct !== null ? `${data.abandonment_rate_pct}%` : null}
          sublabel="carts left without buying"
        />
        <KpiTile
          label="Recovery rate"
          help="Of all carts started, the share that went on to a completed purchase."
          value={data.recovery_rate_pct !== null ? `${data.recovery_rate_pct}%` : null}
          sublabel="carts that ended in a purchase"
        />
      </div>

      <RecoveryBar data={data} />
    </div>
  );
}
