'use client';

/**
 * RecognitionDonut — donut chart of revenue recognition states.
 * States: provisional → settling → finalized.
 *
 * A11y:
 *   - Chart SVG: role="img" + aria-label (via ChartContainer).
 *   - Screen-reader fallback: VisuallyHidden <table> beside the SVG.
 *   - Each segment has a distinct icon + label (not color alone).
 *   - Custom legend uses icon+label pairs, never color alone.
 * Money: labels use formatMoneyDisplay (minor units → locale string).
 */

import * as React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { ChartContainer, ChartTooltipContent, ChartLegendContent } from '@/components/ui/chart';
import type { ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { BarChart3 } from 'lucide-react';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { AnalyticsRecognitionBreakdownResponse } from '@/lib/api/types';

interface RecognitionDonutProps {
  data: AnalyticsRecognitionBreakdownResponse | undefined;
  isLoading: boolean;
  className?: string;
}

const CHART_CONFIG: ChartConfig = {
  provisional: { label: 'Provisional', color: 'hsl(var(--chart-4))' },
  settling: { label: 'Settling', color: 'hsl(var(--chart-2))' },
  finalized: { label: 'Finalized', color: 'hsl(var(--chart-3))' },
};

const LABEL_ICONS: Record<string, string> = {
  provisional: 'P',
  settling: 'S',
  finalized: 'F',
};

// Detect reduced-motion preference
function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function RecognitionDonut({ data, isLoading, className }: RecognitionDonutProps) {
  const reducedMotion = useReducedMotion();

  if (isLoading) {
    return (
      <div className={className} aria-busy="true" aria-label="Recognition breakdown — loading">
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (!data || data.state === 'no_data') {
    return (
      <div className={className}>
        <EmptyState
          title="No recognition data yet"
          description="Recognition states will appear once ledger data is available."
          icon={<BarChart3 className="h-8 w-8" />}
        />
      </div>
    );
  }

  const breakdown = data.breakdown ?? [];
  if (breakdown.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No data in this period"
          icon={<BarChart3 className="h-8 w-8" />}
        />
      </div>
    );
  }

  const primaryCurrency = (breakdown[0]?.currency_code ?? 'INR') as CurrencyCode;

  const chartData = breakdown.map((item) => ({
    name: item.label,
    value: Number(BigInt(item.amount_minor) / 100n),
    amount_minor: item.amount_minor,
    count: item.count,
    color: CHART_CONFIG[item.label]?.color ?? 'hsl(var(--chart-1))',
  }));

  // Screen-reader fallback table
  const srTable = (
    <table className="sr-only" aria-label="Recognition breakdown data table">
      <caption>Revenue recognition breakdown</caption>
      <thead>
        <tr>
          <th scope="col">State</th>
          <th scope="col">Amount</th>
          <th scope="col">Orders</th>
        </tr>
      </thead>
      <tbody>
        {breakdown.map((item) => (
          <tr key={item.label}>
            <td>{CHART_CONFIG[item.label]?.label ?? item.label}</td>
            <td>{formatMoneyDisplay(item.amount_minor, primaryCurrency)}</td>
            <td>{item.count} orders</td>
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
        aria-label="Revenue recognition state donut chart — provisional, settling, finalized"
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius="55%"
              outerRadius="75%"
              isAnimationActive={!reducedMotion}
              aria-label="Recognition state distribution"
            >
              {chartData.map((entry) => (
                <Cell
                  key={entry.name}
                  fill={entry.color}
                  aria-label={`${CHART_CONFIG[entry.name]?.label ?? entry.name}: ${formatMoneyDisplay(entry.amount_minor, primaryCurrency)}`}
                />
              ))}
            </Pie>
            <Tooltip
              content={
                <ChartTooltipContent
                  formatter={(value, name) => {
                    const item = breakdown.find((b) => b.label === name);
                    if (item) {
                      return `${formatMoneyDisplay(item.amount_minor, primaryCurrency)} (${item.count} orders)`;
                    }
                    return String(value);
                  }}
                />
              }
            />
            <Legend
              content={(props) => (
                <ChartLegendContent
                  payload={chartData.map((d) => ({
                    value: CHART_CONFIG[d.name]?.label ?? d.name,
                    color: d.color,
                    dataKey: d.name,
                  }))}
                />
              )}
            />
          </PieChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  );
}
