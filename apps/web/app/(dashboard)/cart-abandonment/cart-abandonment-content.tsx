'use client';

/**
 * CartAbandonmentContent — the cart-recovery surface (P2).
 *
 * Reads ONLY via the BFF GET /api/v1/analytics/abandoned-cart (the metric-engine
 * storefront-abandoned-cart seam) — which now resolves to the Gold mart
 * gold_abandoned_cart through the serving view brain_serving.mv_gold_abandoned_cart (duckdb-serving).
 * Never StarRocks / raw SQL. brand_id is taken from the session by the BFF, never the client.
 *
 * Of the storefront sessions that added to cart, this shows how many recovered (stitched to an
 * order) versus abandoned, the recovery-rate KPI, and an outcome breakdown table.
 *
 * Honest states: skeleton (aria-busy), ErrorCard with request_id, and an honest empty state
 * linking to pixel setup — never a fabricated zero. Counts are integer (bigint→string);
 * percentages are 2dp strings from the engine (never re-divided with floats here).
 *
 * "Send reminder" is a DISABLED honest stub: Brain does not yet have an outbound
 * cart-reminder send capability (the recommendation-action ledger only records actions against
 * an existing recommendation_id, which a generic cart reminder has none of). Rather than
 * fabricate a working action, the button is disabled with a tooltip explaining why.
 */

import { useState } from 'react';
import Link from 'next/link';
import { ShoppingCart, ArrowRight, Send } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MetricTitle } from '@/components/ui/metric-title';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { Tooltip } from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { DateRangeFilter, initialRange, type DateRange } from '@/components/ui/date-range-filter';
import { useAbandonedCart } from '@/lib/hooks/use-analytics';
import type { AnalyticsAbandonedCartResponse } from '@/lib/api/types';

type AbandonedHasData = Extract<AnalyticsAbandonedCartResponse, { state: 'has_data' }>;

function num(s: string): string {
  return Number(s).toLocaleString('en-IN');
}

/** Disabled honest stub — no outbound cart-reminder send capability exists yet. */
function SendReminderButton() {
  return (
    <Tooltip content="Outbound cart reminders aren't wired up yet — connect a messaging channel to enable this.">
      {/* Disabled buttons swallow pointer events, so the span carries the tooltip + focus. */}
      <span tabIndex={0} className="inline-flex">
        <Button variant="outline" size="sm" disabled aria-disabled="true">
          <Send className="mr-2 h-4 w-4" aria-hidden="true" />
          Send reminder
        </Button>
      </span>
    </Tooltip>
  );
}

function Loading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading cart recovery…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function EmptyCard() {
  return (
    <Card data-testid="cart-abandonment-empty">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <ShoppingCart className="h-8 w-8" />
        </div>
        <div>
          <p className="font-medium text-foreground">No cart activity yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            Cart recovery appears once the Brain Pixel captures add-to-cart events and orders are
            stitched back to those sessions. It builds from the Gold abandoned-cart mart.
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

function OutcomeTable({ data }: { data: AbandonedHasData }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          <MetricTitle
            label="Cart outcome breakdown"
            help="Of the visits where something was added to a cart, how many ended in a purchase versus none."
          />
        </CardTitle>
        <SendReminderButton />
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Outcome</TableHead>
              <TableHead numeric>Sessions</TableHead>
              <TableHead numeric>Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">All carts started</TableCell>
              <TableCell numeric>{num(data.cart_sessions)}</TableCell>
              <TableCell numeric>100%</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Went on to buy</TableCell>
              <TableCell numeric>{num(data.converted_sessions)}</TableCell>
              <TableCell numeric>{data.recovery_rate_pct !== null ? `${data.recovery_rate_pct}%` : '—'}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Left without buying</TableCell>
              <TableCell numeric>{num(data.abandoned_sessions)}</TableCell>
              <TableCell numeric>{data.abandonment_rate_pct !== null ? `${data.abandonment_rate_pct}%` : '—'}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function CartAbandonmentData({ data }: { data: AbandonedHasData }) {
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
          label="Recovery rate"
          help="Of all carts started, the share that went on to a completed purchase."
          value={data.recovery_rate_pct !== null ? `${data.recovery_rate_pct}%` : null}
          sublabel="carts that ended in a purchase"
        />
        <KpiTile
          label="Abandonment rate"
          help="Of all carts started, the share that were left without a purchase."
          value={data.abandonment_rate_pct !== null ? `${data.abandonment_rate_pct}%` : null}
          sublabel="carts left without buying"
        />
      </div>

      <OutcomeTable data={data} />
    </div>
  );
}

export function CartAbandonmentContent() {
  const [range, setRange] = useState<DateRange>(() => initialRange());

  const q = useAbandonedCart({ from: range.from, to: range.to });
  const data = q.data;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Cart Abandonment"
        description="Of the visits where something was added to a cart, how many went on to purchase versus left without buying — captured by the Brain Pixel and matched to orders."
        meta={
          <span
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Read from the Gold mart (gold_abandoned_cart) via the serving view mv_gold_abandoned_cart."
          >
            <ShoppingCart className="h-3 w-3" aria-hidden="true" />
            Powered by the Gold tier
          </span>
        }
      />

      <section aria-label="Cart recovery">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">Cart recovery</h2>
          <DateRangeFilter value={range} onChange={setRange} aria-label="Cart abandonment date range" />
        </div>

        {q.isLoading && <Loading />}
        {!q.isLoading && q.error && <ErrorCard error={q.error} retry={q.refetch} />}
        {!q.isLoading && !q.error && data?.state === 'no_data' && <EmptyCard />}
        {!q.isLoading && !q.error && data?.state === 'has_data' && <CartAbandonmentData data={data} />}
      </section>
    </div>
  );
}
