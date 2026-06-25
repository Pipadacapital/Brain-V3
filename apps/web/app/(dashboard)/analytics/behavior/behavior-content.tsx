'use client';

/**
 * BehaviorContent — the storefront-behavior surface (Silver tier).
 *
 * Reads ONLY via the BFF /api/v1/analytics/behavior/overview (the metric-engine storefront-behavior
 * seam over silver_touchpoint, I-ST01) — never StarRocks/SQL directly. Surfaces the rich pixel
 * auto-instrumentation that previously only fed journey reconstruction: what shoppers browse
 * (page-type mix), which products they view, and what they search for.
 *
 * Honest states: skeleton (aria-busy), ErrorCard with request_id, and an honest empty state linking
 * to pixel setup — never a fabricated zero. Counts are integer (bigint→string); shares are 2dp
 * strings from the engine (never re-divided with floats here).
 */

import { useState } from 'react';
import Link from 'next/link';
import { MousePointerClick, ArrowRight, Eye, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { useBehaviorOverview } from '@/lib/hooks/use-analytics';
import type { AnalyticsBehaviorOverviewResponse } from '@/lib/api/types';

type BehaviorHasData = Extract<AnalyticsBehaviorOverviewResponse, { state: 'has_data' }>;

const RANGE_PRESETS = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
] as const;
type RangeKey = (typeof RANGE_PRESETS)[number]['key'];

function rangeFor(days: number): { from: string; to: string } {
  const to = new Date().toISOString().split('T')[0] as string;
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
  return { from, to };
}

function num(s: string): string {
  return Number(s).toLocaleString('en-IN');
}

function Loading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading storefront behavior…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
    <Card data-testid="behavior-empty">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <MousePointerClick className="h-8 w-8" />
        </div>
        <div>
          <p className="font-medium text-foreground">No browsing activity yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            Storefront behavior appears once the Brain Pixel captures page, product, and search
            views. Page-type mix, top viewed products, and top searches build from those touchpoints
            in the Silver tier.
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

function PageTypeMix({ rows }: { rows: BehaviorHasData['page_type_mix'] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Where shoppers browse (page-type mix)</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No page-view breakdown in this window yet.</p>
        ) : (
          <ul className="space-y-2" aria-label="Page-type mix">
            {rows.map((r) => (
              <li key={r.page_type}>
                <div className="flex items-center justify-between text-sm mb-0.5">
                  <span className="text-foreground capitalize">{r.page_type}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {num(r.count)}{r.share_pct !== null && <span className="ml-2">{r.share_pct}%</span>}
                  </span>
                </div>
                <div className="h-1.5 rounded bg-muted overflow-hidden" aria-hidden="true">
                  <div className="h-full bg-foreground/70" style={{ width: `${Math.min(100, Number(r.share_pct ?? 0))}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TopList({
  title,
  icon,
  keyLabel,
  rows,
  testid,
}: {
  title: string;
  icon: React.ReactNode;
  keyLabel: string;
  rows: BehaviorHasData['top_products'];
  testid: string;
}) {
  return (
    <Card data-testid={testid}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No {keyLabel.toLowerCase()} in this window yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-1.5 font-medium">{keyLabel}</th>
                <th className="py-1.5 font-medium text-right">Views</th>
                <th className="py-1.5 font-medium text-right">Shoppers</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 text-foreground truncate max-w-[16rem]" title={r.key}>{r.key}</td>
                  <td className="py-1.5 text-right tabular-nums">{num(r.count)}</td>
                  <td className="py-1.5 text-right tabular-nums">{num(r.reach)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

export function BehaviorContent() {
  const [rangeKey, setRangeKey] = useState<RangeKey>('30');
  const preset = RANGE_PRESETS.find((p) => p.key === rangeKey) ?? RANGE_PRESETS[1];
  const { from, to } = rangeFor(preset.days);

  const q = useBehaviorOverview({ from, to });
  const data = q.data;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Behavior"
        description="What shoppers actually do on the storefront — page-type mix, the products they view, and the searches they run — captured by the Brain Pixel and folded into the journey touchpoints."
        meta={
          <span
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Read from the Silver tier (silver_touchpoint) via the metric-engine storefront-behavior seam."
          >
            <MousePointerClick className="h-3 w-3" aria-hidden="true" />
            Powered by the Silver tier
          </span>
        }
      />

      <section aria-label="Storefront behavior">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">Storefront activity</h2>
          <div role="group" aria-label="Date range" className="inline-flex rounded-md border border-border p-0.5">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setRangeKey(p.key)}
                aria-pressed={rangeKey === p.key}
                className={
                  rangeKey === p.key
                    ? 'rounded px-3 py-1 text-xs font-medium bg-foreground text-background'
                    : 'rounded px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground'
                }
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {q.isLoading && <Loading />}
        {!q.isLoading && q.error && <ErrorCard error={q.error} retry={q.refetch} />}
        {!q.isLoading && !q.error && data?.state === 'no_data' && <EmptyCard />}
        {!q.isLoading && !q.error && data?.state === 'has_data' && <BehaviorData data={data} />}
      </section>
    </div>
  );
}

function BehaviorData({ data }: { data: BehaviorHasData }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile label="Sessions" value={num(data.sessions)} sublabel={`${data.from} → ${data.to}`} />
        <KpiTile label="Active journeys" value={num(data.journeys)} sublabel="distinct shoppers" />
        <KpiTile label="Touches" value={num(data.touches)} sublabel="tracked interactions" />
      </div>

      <PageTypeMix rows={data.page_type_mix} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TopList
          title="Top viewed products"
          icon={<Eye className="h-4 w-4" aria-hidden="true" />}
          keyLabel="Product"
          testid="behavior-top-products"
          rows={data.top_products}
        />
        <TopList
          title="Top searches"
          icon={<Search className="h-4 w-4" aria-hidden="true" />}
          keyLabel="Search"
          testid="behavior-top-searches"
          rows={data.top_searches}
        />
      </div>
    </div>
  );
}
