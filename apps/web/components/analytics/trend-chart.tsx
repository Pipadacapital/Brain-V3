'use client';

/**
 * TrendChart — stacked area chart: realized vs provisional revenue over time.
 *
 * A11y:
 *   - Chart SVG carries role="img" + aria-label (via ChartContainer).
 *   - Screen-reader fallback: VisuallyHidden <table> beside the SVG.
 *   - Status/series distinguished by color + pattern + legend label, never color alone.
 *   - prefers-reduced-motion: Recharts animations are disabled when reduced-motion active.
 * Money: values are minor-unit strings → formatted via formatMoneyDisplay at tooltip render.
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
import { TrendingUp } from 'lucide-react';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { AnalyticsTimeseriesResponse } from '@/lib/api/types';

interface TrendChartProps {
  data: AnalyticsTimeseriesResponse | undefined;
  isLoading: boolean;
  grain?: 'day' | 'week';
  className?: string;
}

const CHART_CONFIG: ChartConfig = {
  realized: { label: 'Realized', color: 'hsl(var(--chart-1))' },
  provisional: { label: 'Provisional', color: 'hsl(var(--chart-2))' },
};

/**
 * Convert minor-unit string to a display number for Recharts.
 * We render the chart Y-axis in major units (divide by 100).
 * Tooltips use formatMoneyDisplay for the exact locale-formatted value.
 */
function minorToMajor(minorStr: string): number {
  // Integer divide by 100 for display — chart Y axis uses major units
  const major = BigInt(minorStr) / 100n;
  return Number(major);
}

function formatAxisLabel(value: number, currency: string): string {
  if (value >= 1_00_000) return `${(value / 1_00_000).toFixed(1)}L`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

// Detect reduced-motion preference
function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function TrendChart({ data, isLoading, grain = 'day', className }: TrendChartProps) {
  const reducedMotion = useReducedMotion();

  if (isLoading) {
    return (
      <div className={className} aria-busy="true" aria-label="Revenue trend — loading">
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (!data || data.state === 'no_data') {
    return (
      <div className={className}>
        <EmptyState
          title="No trend data yet"
          description="Revenue trend will appear once ledger data is available."
          icon={<TrendingUp className="h-8 w-8" />}
        />
      </div>
    );
  }

  // Build chart data — group by bucket (M1: single currency per brand)
  const buckets = data.buckets ?? [];
  if (buckets.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No data in this period"
          description="Revenue will appear here as new orders are recognized."
          icon={<TrendingUp className="h-8 w-8" />}
        />
      </div>
    );
  }

  // Derive primary currency from first bucket
  const primaryCurrency = (buckets[0]?.currency_code ?? 'INR') as CurrencyCode;

  const chartData = buckets.map((b) => ({
    bucket: b.bucket,
    realized: minorToMajor(b.realized_minor),
    provisional: minorToMajor(b.provisional_minor),
    // Keep raw for tooltip
    realized_minor: b.realized_minor,
    provisional_minor: b.provisional_minor,
  }));

  // Format bucket label for X axis
  const formatBucket = (bucket: string): string => {
    const d = new Date(`${bucket}T00:00:00Z`);
    if (grain === 'week') {
      return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
  };

  // Screen-reader fallback table
  const srTable = (
    <table className="sr-only" aria-label="Revenue trend data table">
      <caption>Revenue trend — {grain === 'week' ? 'weekly' : 'daily'}</caption>
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Realized</th>
          <th scope="col">Provisional</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={row.bucket}>
            <td>{row.bucket}</td>
            <td>
              {formatMoneyDisplay(
                buckets.find((b) => b.bucket === row.bucket)?.realized_minor ?? '0',
                primaryCurrency,
              )}
            </td>
            <td>
              {formatMoneyDisplay(
                buckets.find((b) => b.bucket === row.bucket)?.provisional_minor ?? '0',
                primaryCurrency,
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className={className}>
      {/* Screen-reader data table (hidden visually, authoritative for a11y) */}
      {srTable}

      <ChartContainer
        config={CHART_CONFIG}
        className="h-64 w-full"
        aria-label={`Revenue trend chart — ${grain === 'week' ? 'weekly' : 'daily'} realized vs provisional`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradRealized" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-realized)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-realized)" stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="gradProvisional" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-provisional)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-provisional)" stopOpacity={0.05} />
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
              tickFormatter={(v) => formatAxisLabel(v as number, primaryCurrency)}
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              width={56}
            />
            <Tooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(label) => formatBucket(label)}
                  formatter={(value, name, entry) => {
                    // Read the raw minor-unit string straight off the row (robust — no
                    // value-matching, which broke when two series/buckets shared a value).
                    const row = entry?.payload as
                      | { realized_minor?: string; provisional_minor?: string }
                      | undefined;
                    if (name === 'realized' && row?.realized_minor != null) {
                      return formatMoneyDisplay(row.realized_minor, primaryCurrency);
                    }
                    if (name === 'provisional' && row?.provisional_minor != null) {
                      return formatMoneyDisplay(row.provisional_minor, primaryCurrency);
                    }
                    return String(value);
                  }}
                />
              }
            />
            <Legend content={<ChartLegendContent />} />
            <Area
              type="monotone"
              dataKey="realized"
              stroke="var(--color-realized)"
              fill="url(#gradRealized)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={!reducedMotion}
              aria-label="Realized revenue"
            />
            <Area
              type="monotone"
              dataKey="provisional"
              stroke="var(--color-provisional)"
              fill="url(#gradProvisional)"
              strokeWidth={2}
              dot={false}
              strokeDasharray="4 2"
              isAnimationActive={!reducedMotion}
              aria-label="Provisional revenue"
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  );
}
