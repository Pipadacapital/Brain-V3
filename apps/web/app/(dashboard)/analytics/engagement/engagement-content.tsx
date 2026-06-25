'use client';

/**
 * EngagementContent — the storefront-engagement surface (Silver tier, Phase H pixel).
 *
 * Reads ONLY via the BFF /api/v1/analytics/engagement (the metric-engine storefront-engagement seam
 * over silver_touchpoint, I-ST01) — never StarRocks/SQL directly. Shows engagement depth: engaged
 * (multi-touch) vs bounce (single-touch) sessions, the engagement/bounce rates, and average touches
 * per session.
 *
 * Honest states: skeleton (aria-busy), ErrorCard with request_id, and an honest empty state linking
 * to pixel setup — never a fabricated zero. Counts are integer (bigint→string); ratios are 2dp strings
 * from the engine (never re-divided with floats here).
 */

import { useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { DateRangeFilter, initialRange, type DateRange } from '@/components/ui/date-range-filter';
import { useEngagement } from '@/lib/hooks/use-analytics';
import type { AnalyticsEngagementResponse } from '@/lib/api/types';

type EngagementHasData = Extract<AnalyticsEngagementResponse, { state: 'has_data' }>;

function num(s: string): string {
  return Number(s).toLocaleString('en-IN');
}

function Loading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading engagement…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Skeleton className="h-28 w-full" />
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
    <Card data-testid="engagement-empty">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <Activity className="h-8 w-8" />
        </div>
        <div>
          <p className="font-medium text-foreground">No engagement yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            Engagement appears once the Brain Pixel captures storefront sessions. It measures how deeply
            shoppers browse — engaged (multi-page) vs bounced sessions — from the journey touchpoints in
            the Silver tier.
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

function EngagementBar({ data }: { data: EngagementHasData }) {
  const engaged = Math.min(100, Number(data.engagement_rate_pct ?? 0));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Engagement depth ({num(data.sessions)} sessions)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-foreground">Engaged (multi-touch)</span>
          <span className="text-muted-foreground tabular-nums">
            {num(data.engaged_sessions)}
            {data.engagement_rate_pct !== null && <span className="ml-2 text-foreground">{data.engagement_rate_pct}%</span>}
          </span>
        </div>
        <div className="h-3 rounded bg-muted overflow-hidden" aria-hidden="true">
          <div className="h-full bg-foreground/70" style={{ width: `${engaged}%` }} />
        </div>
        <div className="flex items-center justify-between text-sm pt-1">
          <span className="text-foreground">Bounced (single-touch)</span>
          <span className="text-muted-foreground tabular-nums">
            {num(data.bounce_sessions)}
            {data.bounce_rate_pct !== null && <span className="ml-2">{data.bounce_rate_pct}%</span>}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function EngagementContent() {
  const [range, setRange] = useState<DateRange>(() => initialRange());

  const q = useEngagement({ from: range.from, to: range.to });
  const data = q.data;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Engagement"
        description="How deeply storefront sessions engage — engaged (multi-page) versus bounced sessions and the average touches per session — captured by the Brain Pixel in the Silver tier."
        meta={
          <span
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Read from the Silver tier (silver_touchpoint) via the metric-engine storefront-engagement seam."
          >
            <Activity className="h-3 w-3" aria-hidden="true" />
            Powered by the Silver tier
          </span>
        }
      />

      <section aria-label="Engagement">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">Session engagement</h2>
          <DateRangeFilter value={range} onChange={setRange} aria-label="Engagement date range" />
        </div>

        {q.isLoading && <Loading />}
        {!q.isLoading && q.error && <ErrorCard error={q.error} retry={q.refetch} />}
        {!q.isLoading && !q.error && data?.state === 'no_data' && <EmptyCard />}
        {!q.isLoading && !q.error && data?.state === 'has_data' && <EngagementData data={data} />}
      </section>
    </div>
  );
}

function EngagementData({ data }: { data: EngagementHasData }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <KpiTile label="Sessions" value={num(data.sessions)} sublabel={`${data.from} → ${data.to}`} />
        <KpiTile
          label="Engagement rate"
          value={data.engagement_rate_pct !== null ? `${data.engagement_rate_pct}%` : '—'}
          sublabel="multi-touch sessions"
        />
        <KpiTile
          label="Bounce rate"
          value={data.bounce_rate_pct !== null ? `${data.bounce_rate_pct}%` : '—'}
          sublabel="single-touch sessions"
        />
        <KpiTile
          label="Avg touches / session"
          value={data.avg_touches_per_session ?? '—'}
          sublabel={`${num(data.touches)} total touches`}
        />
      </div>

      <EngagementBar data={data} />
    </div>
  );
}
