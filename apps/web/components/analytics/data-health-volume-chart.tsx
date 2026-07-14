'use client';

/**
 * DataHealthVolumeChart — bronze-event ingestion volume over time (last 30 days).
 *
 * Mirrors TrendChart's a11y contract:
 *   - SVG carries role="img" + aria-label via ChartContainer.
 *   - Screen-reader fallback: a VisuallyHidden <table> beside the SVG (the table is the truth).
 *   - prefers-reduced-motion disables Recharts animation.
 *   - Series carries a legend label — not colour alone.
 *   - Tooltip reads the raw bigint count straight off entry.payload (never value-match).
 * Counts are bigint strings → rendered via Number(BigInt(...)) for the chart only; the SR
 * table shows the locale-grouped count. No money here (event counts, not currency).
 * Empty: honest EmptyState when state='no_data' or zero buckets — never fabricates 0.
 */

import * as React from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { ChartContainer, ChartTooltipContent } from '@/components/ui/chart';
import type { ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Activity } from 'lucide-react';
import type { AnalyticsDataHealthVolumeBucket } from '@/lib/api/types';

interface DataHealthVolumeChartProps {
  data: AnalyticsDataHealthVolumeBucket[] | undefined;
  isLoading: boolean;
  className?: string;
}

const CHART_CONFIG: ChartConfig = {
  count: { label: 'Events', color: 'hsl(var(--chart-1))' },
};

function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function toCount(countStr: string): number {
  return Number(BigInt(countStr));
}

function formatAxisCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

function formatBucket(bucket: string): string {
  const d = new Date(`${bucket}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return bucket;
  return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
}

export function DataHealthVolumeChart({
  data,
  isLoading,
  className,
}: DataHealthVolumeChartProps) {
  const reducedMotion = useReducedMotion();

  if (isLoading) {
    return (
      <div className={className} aria-busy="true" aria-label="Event volume — loading">
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  const buckets = data ?? [];
  if (buckets.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No events yet"
          description="This chart fills in once your data sources start sending events."
          icon={<Activity className="h-8 w-8" />}
        />
      </div>
    );
  }

  const chartData = buckets.map((b) => ({
    bucket: b.bucket,
    count: toCount(b.count),
    count_raw: b.count, // raw bigint string for the tooltip
  }));

  const srTable = (
    <table className="sr-only" aria-label="Events received per day data table">
      <caption>Events received per day — last 30 days</caption>
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Events</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((b) => (
          <tr key={b.bucket}>
            <td>{b.bucket}</td>
            <td>{Number(BigInt(b.count)).toLocaleString('en-IN')}</td>
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
        aria-label="Events received per day — bar chart, last 30 days"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis
              dataKey="bucket"
              tickFormatter={formatBucket}
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              interval="preserveStartEnd"
            />
            <YAxis
              tickFormatter={(v) => formatAxisCount(v as number)}
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              width={48}
              allowDecimals={false}
            />
            <Tooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(label) => formatBucket(label as string)}
                  formatter={(value, _name, entry) => {
                    const row = entry?.payload as { count_raw?: string } | undefined;
                    const raw = row?.count_raw;
                    const n = raw != null ? Number(BigInt(raw)) : Number(value);
                    return `${n.toLocaleString('en-IN')} events`;
                  }}
                />
              }
            />
            <Bar
              dataKey="count"
              name="Events"
              fill="var(--color-count)"
              radius={[2, 2, 0, 0]}
              isAnimationActive={!reducedMotion}
              aria-label="Events"
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  );
}
