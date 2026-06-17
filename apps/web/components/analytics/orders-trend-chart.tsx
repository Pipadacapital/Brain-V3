'use client';

/**
 * OrdersTrendChart — orders-over-time: total order count with an RTO-count overlay.
 *
 * Orders-only chart (Phase-1 TrendChart is hardcoded to revenue realized/provisional and
 * typed to AnalyticsTimeseriesResponse, so it cannot render the orders shape). Named
 * orders-* under components/analytics to avoid clashing with the data-health agent.
 *
 * A11y:
 *   - Chart SVG carries role="img" + aria-label (via ChartContainer).
 *   - Screen-reader fallback: a visually-hidden <table> beside the SVG is the source of truth.
 *   - The two series are distinguished by colour + a dashed stroke + a distinct legend
 *     label, never colour alone.
 *   - prefers-reduced-motion: Recharts animations are disabled when reduced-motion is active.
 * Counts: order_count / rto_count are bigint strings → BigInt() parsed, never floats.
 *   The chart Y axis plots whole counts (no money math here; money is elsewhere).
 * Empty: renders EmptyState on state='no_data' or an empty bucket list — never fabricates 0.
 */

import * as React from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
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
import { ShoppingCart } from 'lucide-react';
import type { AnalyticsOrdersTimeseriesResponse } from '@/lib/api/types';

interface OrdersTrendChartProps {
  data: AnalyticsOrdersTimeseriesResponse | undefined;
  isLoading: boolean;
  grain?: 'day' | 'week';
  className?: string;
}

const CHART_CONFIG: ChartConfig = {
  orders: { label: 'Orders', color: 'hsl(var(--chart-1))' },
  rto: { label: 'RTO', color: 'hsl(var(--chart-2))' },
};

/** Parse a bigint count string to a chart-safe number (counts fit in Number range). */
function countToNumber(countStr: string): number {
  return Number(BigInt(countStr));
}

function formatAxisCount(value: number): string {
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
}

// Detect reduced-motion preference (matches TrendChart pattern).
function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function OrdersTrendChart({ data, isLoading, grain = 'day', className }: OrdersTrendChartProps) {
  const reducedMotion = useReducedMotion();

  if (isLoading) {
    return (
      <div className={className} aria-busy="true" aria-label="Orders trend — loading">
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (!data || data.state === 'no_data') {
    return (
      <div className={className}>
        <EmptyState
          title="No orders trend yet"
          description="Orders over time will appear once order data is available."
          icon={<ShoppingCart className="h-8 w-8" />}
        />
      </div>
    );
  }

  const buckets = data.buckets ?? [];
  if (buckets.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No orders in this period"
          description="Try a wider date range."
          icon={<ShoppingCart className="h-8 w-8" />}
        />
      </div>
    );
  }

  // Multiple currencies → multiple rows per bucket. M1 is single-currency INR, but we
  // sum order/RTO counts per bucket across currencies so the trend stays correct if a
  // second currency lands. (Counts are currency-agnostic; no money blending here.)
  const byBucket = new Map<string, { bucket: string; orders: number; rto: number }>();
  for (const b of buckets) {
    const existing = byBucket.get(b.bucket);
    const orders = countToNumber(b.order_count);
    const rto = countToNumber(b.rto_count);
    if (existing) {
      existing.orders += orders;
      existing.rto += rto;
    } else {
      byBucket.set(b.bucket, { bucket: b.bucket, orders, rto });
    }
  }
  const chartData = Array.from(byBucket.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));

  const formatBucket = (bucket: string): string => {
    const d = new Date(`${bucket}T00:00:00Z`);
    return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
  };

  // Screen-reader fallback table — the authoritative data for a11y.
  const srTable = (
    <table className="sr-only" aria-label="Orders trend data table">
      <caption>Orders trend — {grain === 'week' ? 'weekly' : 'daily'} order count with RTO count</caption>
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Orders</th>
          <th scope="col">RTO</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={row.bucket}>
            <td>{row.bucket}</td>
            <td>{row.orders.toLocaleString('en-IN')}</td>
            <td>{row.rto.toLocaleString('en-IN')}</td>
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
        aria-label={`Orders trend chart — ${grain === 'week' ? 'weekly' : 'daily'} order count with RTO overlay`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradOrders" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-orders)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-orders)" stopOpacity={0.05} />
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
              tickFormatter={(v) => formatAxisCount(v as number)}
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              width={48}
              allowDecimals={false}
            />
            <Tooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(label) => formatBucket(label)}
                  formatter={(value, name, entry) => {
                    // Read the raw count straight off the row payload (robust — no value-matching).
                    const row = entry?.payload as { orders?: number; rto?: number } | undefined;
                    if (name === 'orders' && row?.orders != null) {
                      return `${row.orders.toLocaleString('en-IN')} orders`;
                    }
                    if (name === 'rto' && row?.rto != null) {
                      return `${row.rto.toLocaleString('en-IN')} RTO`;
                    }
                    return String(value);
                  }}
                />
              }
            />
            <Legend content={<ChartLegendContent />} />
            {/* Total orders — filled area (primary series). */}
            <Area
              type="monotone"
              dataKey="orders"
              stroke="var(--color-orders)"
              fill="url(#gradOrders)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={!reducedMotion}
              aria-label="Total order count"
            />
            {/* RTO overlay — dashed line so it is distinguishable without colour. */}
            <Line
              type="monotone"
              dataKey="rto"
              stroke="var(--color-rto)"
              strokeWidth={2}
              strokeDasharray="4 2"
              dot={false}
              isAnimationActive={!reducedMotion}
              aria-label="RTO (return-to-origin) count"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  );
}
