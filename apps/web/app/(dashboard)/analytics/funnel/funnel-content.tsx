'use client';

/**
 * FunnelContent — the storefront conversion-funnel surface (Silver tier, Phase H pixel).
 *
 * Reads ONLY via the BFF /api/v1/analytics/funnel (the metric-engine storefront-funnel seam over
 * silver_touchpoint, I-ST01) — never StarRocks/SQL directly. Shows session reach at each stage
 * (sessions → product views → cart adds → purchases) with conversion % vs the funnel top and the
 * step-over-previous drop-off.
 *
 * Honest states: skeleton (aria-busy), ErrorCard with request_id, and an honest empty state linking
 * to pixel setup — never a fabricated zero. Counts are integer (bigint→string); percentages are 2dp
 * strings from the engine (never re-divided with floats here).
 */

import { useState } from 'react';
import Link from 'next/link';
import { Filter, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { DateRangeFilter, initialRange, type DateRange } from '@/components/ui/date-range-filter';
import { useFunnelAnalytics } from '@/lib/hooks/use-analytics';
import type { AnalyticsFunnelResponse } from '@/lib/api/types';

type FunnelHasData = Extract<AnalyticsFunnelResponse, { state: 'has_data' }>;

// Friendly labels for the four stage keys emitted by the engine.
const STAGE_LABELS: Record<string, string> = {
  sessions: 'Sessions',
  product_viewed: 'Viewed a product',
  cart_added: 'Added to cart',
  purchased: 'Purchased',
};

function num(s: string): string {
  return Number(s).toLocaleString('en-IN');
}

function Loading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading conversion funnel…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function EmptyCard() {
  return (
    <Card data-testid="funnel-empty">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <Filter className="h-8 w-8" />
        </div>
        <div>
          <p className="font-medium text-foreground">No funnel activity yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            The conversion funnel appears once the Brain Pixel captures sessions, product views, and
            cart adds — and orders are stitched back to those sessions. It builds from the journey
            touchpoints in the Silver tier.
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

function FunnelBars({ stages }: { stages: FunnelHasData['stages'] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Conversion funnel (session reach per stage)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3" aria-label="Conversion funnel stages">
          {stages.map((s, i) => {
            const widthPct = Math.min(100, Number(s.conversion_pct ?? 0));
            return (
              <li key={s.key}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-foreground">{STAGE_LABELS[s.key] ?? s.key}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {num(s.sessions)}
                    {s.conversion_pct !== null && (
                      <span className="ml-2 text-foreground">{s.conversion_pct}%</span>
                    )}
                    {i > 0 && s.step_pct !== null && (
                      <span className="ml-2 text-xs">({s.step_pct}% of prev)</span>
                    )}
                  </span>
                </div>
                <div className="h-3 rounded bg-muted overflow-hidden" aria-hidden="true">
                  <div className="h-full bg-foreground/70" style={{ width: `${widthPct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

export function FunnelContent() {
  const [range, setRange] = useState<DateRange>(() => initialRange());

  const q = useFunnelAnalytics({ from: range.from, to: range.to });
  const data = q.data;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Funnel"
        description="How storefront sessions convert — from browsing to viewing a product, adding to cart, and purchasing — captured by the Brain Pixel and stitched to orders in the Silver tier."
        meta={
          <span
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Read from the Silver tier (silver_touchpoint) via the metric-engine storefront-funnel seam."
          >
            <Filter className="h-3 w-3" aria-hidden="true" />
            Powered by the Silver tier
          </span>
        }
      />

      <section aria-label="Conversion funnel">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">Storefront conversion</h2>
          <DateRangeFilter value={range} onChange={setRange} aria-label="Funnel date range" />
        </div>

        {q.isLoading && <Loading />}
        {!q.isLoading && q.error && <ErrorCard error={q.error} retry={q.refetch} />}
        {!q.isLoading && !q.error && data?.state === 'no_data' && <EmptyCard />}
        {!q.isLoading && !q.error && data?.state === 'has_data' && <FunnelData data={data} />}
      </section>
    </div>
  );
}

function FunnelData({ data }: { data: FunnelHasData }) {
  const byKey = (k: string) => data.stages.find((s) => s.key === k);
  const sessions = byKey('sessions');
  const purchased = byKey('purchased');
  const cart = byKey('cart_added');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Sessions"
          value={sessions ? num(sessions.sessions) : '0'}
          sublabel={`${data.from} → ${data.to}`}
        />
        <KpiTile
          label="Cart-add rate"
          value={cart?.conversion_pct !== undefined && cart?.conversion_pct !== null ? `${cart.conversion_pct}%` : '—'}
          sublabel="sessions that added to cart"
        />
        <KpiTile
          label="Purchase rate"
          value={purchased?.conversion_pct !== undefined && purchased?.conversion_pct !== null ? `${purchased.conversion_pct}%` : '—'}
          sublabel="sessions that converted"
        />
      </div>

      <FunnelBars stages={data.stages} />
    </div>
  );
}
