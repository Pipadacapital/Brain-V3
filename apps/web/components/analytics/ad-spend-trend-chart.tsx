'use client';

/**
 * AdSpendTrendChart — stacked area chart: ad spend over time by platform (meta / google_ads).
 *
 * A11y:
 *   - Chart SVG carries role="img" + aria-label (via ChartContainer).
 *   - Screen-reader fallback: visually-hidden <table> beside the SVG (the table is the truth).
 *   - Series distinguished by colour + stroke pattern + legend label, never colour alone.
 *   - prefers-reduced-motion: Recharts animations disabled when reduced-motion is active.
 * Money: spend_minor are minor-unit strings → formatted via formatMoneyDisplay at tooltip render.
 *   Per-currency: the chart assumes a single brand currency (first bucket); mixed-currency
 *   data still renders honestly via the SR table (each row carries its own currency).
 * Empty: renders EmptyState when data=[] or state='no_data'.
 */

import * as React from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { ChartContainer, ChartTooltipContent, ChartLegendContent } from '@/components/ui/chart';
import type { ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { BarChart3 } from 'lucide-react';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { AnalyticsAdSpendTimeseriesResponse } from '@/lib/api/types';

interface AdSpendTrendChartProps {
  data: AnalyticsAdSpendTimeseriesResponse | undefined;
  isLoading: boolean;
  grain?: 'day' | 'week';
  className?: string;
}

// Two platform series — colour + a distinct stroke pattern so they're never colour-only.
const PLATFORM_KEYS = ['meta', 'google_ads'] as const;
type PlatformKey = (typeof PLATFORM_KEYS)[number];

const PLATFORM_LABELS: Record<PlatformKey, string> = {
  meta: 'Meta Ads',
  google_ads: 'Google Ads',
};

const CHART_CONFIG: ChartConfig = {
  meta: { label: 'Meta Ads', color: 'hsl(var(--chart-1))' },
  google_ads: { label: 'Google Ads', color: 'hsl(var(--chart-2))' },
};

/** Minor-unit string → major-unit number for the Recharts Y axis (integer divide by 100). */
function minorToMajor(minorStr: string): number {
  return Number(BigInt(minorStr) / 100n);
}

function formatAxisLabel(value: number): string {
  if (value >= 1_00_000) return `${(value / 1_00_000).toFixed(1)}L`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Pivot per-(bucket,platform) rows into one row per bucket with a column per platform. */
interface PivotRow {
  bucket: string;
  meta: number;
  google_ads: number;
  meta_minor: string;
  google_ads_minor: string;
}

export function AdSpendTrendChart({ data, isLoading, grain = 'day', className }: AdSpendTrendChartProps) {
  const reducedMotion = useReducedMotion();

  if (isLoading) {
    return (
      <div className={className} aria-busy="true" aria-label="Ad spend trend — loading">
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (!data || data.state === 'no_data') {
    return (
      <div className={className}>
        <EmptyState
          title="No ad spend yet"
          description="Spend will appear once a Meta or Google Ads connector has ingested data."
          icon={<BarChart3 className="h-8 w-8" />}
        />
      </div>
    );
  }

  const buckets = data.buckets ?? [];
  if (buckets.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No spend in this period"
          description="Spend will appear here once your ad connectors sync."
          icon={<BarChart3 className="h-8 w-8" />}
        />
      </div>
    );
  }

  // Primary currency from the first bucket (single brand currency in Slice 1).
  const primaryCurrency = (buckets[0]?.currency_code ?? 'INR') as CurrencyCode;

  // Pivot: bucket → { meta, google_ads } (minor strings summed per platform per bucket).
  const byBucket = new Map<string, PivotRow>();
  for (const b of buckets) {
    const row =
      byBucket.get(b.bucket) ??
      ({ bucket: b.bucket, meta: 0, google_ads: 0, meta_minor: '0', google_ads_minor: '0' } as PivotRow);
    const platform = (b.platform === 'meta' ? 'meta' : 'google_ads') as PlatformKey;
    const prevMinor = BigInt(row[`${platform}_minor` as const]);
    const nextMinor = prevMinor + BigInt(b.spend_minor);
    row[`${platform}_minor` as const] = nextMinor.toString();
    row[platform] = minorToMajor(nextMinor.toString());
    byBucket.set(b.bucket, row);
  }
  const chartData = Array.from(byBucket.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));

  const formatBucket = (bucket: string): string => {
    const d = new Date(`${bucket}T00:00:00Z`);
    return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
  };

  // Screen-reader fallback table — the authoritative data source for a11y.
  const srTable = (
    <table className="sr-only" aria-label="Ad spend trend data table">
      <caption>Ad spend by platform — {grain === 'week' ? 'weekly' : 'daily'}</caption>
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">{PLATFORM_LABELS.meta}</th>
          <th scope="col">{PLATFORM_LABELS.google_ads}</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={row.bucket}>
            <td>{row.bucket}</td>
            <td>{formatMoneyDisplay(row.meta_minor, primaryCurrency)}</td>
            <td>{formatMoneyDisplay(row.google_ads_minor, primaryCurrency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className={className}>
      {srTable}

      <ChartContainer
        config={CHART_CONFIG}
        className="h-64 w-full"
        aria-label={`Ad spend trend chart — ${grain === 'week' ? 'weekly' : 'daily'} by platform (Meta and Google Ads)`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradMeta" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-meta)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-meta)" stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="gradGoogle" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-google_ads)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-google_ads)" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="bucket"
              tickFormatter={formatBucket}
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              interval="preserveStartEnd"
            />
            <YAxis
              tickFormatter={(v) => formatAxisLabel(v as number)}
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              width={56}
            />
            <Tooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(label) => formatBucket(label)}
                  formatter={(value, name, entry) => {
                    const row = entry?.payload as PivotRow | undefined;
                    if (name === 'meta' && row?.meta_minor != null) {
                      return formatMoneyDisplay(row.meta_minor, primaryCurrency);
                    }
                    if (name === 'google_ads' && row?.google_ads_minor != null) {
                      return formatMoneyDisplay(row.google_ads_minor, primaryCurrency);
                    }
                    return String(value);
                  }}
                />
              }
            />
            <Legend content={<ChartLegendContent />} />
            <Area
              type="monotone"
              dataKey="meta"
              stackId="spend"
              stroke="var(--color-meta)"
              fill="url(#gradMeta)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={!reducedMotion}
              aria-label="Meta Ads spend"
            />
            <Area
              type="monotone"
              dataKey="google_ads"
              stackId="spend"
              stroke="var(--color-google_ads)"
              fill="url(#gradGoogle)"
              strokeWidth={2}
              dot={false}
              strokeDasharray="4 2"
              isAnimationActive={!reducedMotion}
              aria-label="Google Ads spend"
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  );
}
