'use client';

/**
 * CheckoutFunnelChart — Shopflo abandoned-checkout funnel.
 *
 * The Shopflo webhook fires on checkout_abandoned, so every row is an abandoned
 * checkout. The funnel shows the abandoned total and the two segmentation slices
 * that matter for recovery: reached-address (late abandon) vs discount-applied
 * (discount-leakage signal). Rendered as a stepped horizontal bar set.
 *
 * A11y:
 *   - SVG carries role="img" + aria-label (via ChartContainer).
 *   - Screen-reader fallback: a visually-hidden <table> is the source of truth.
 *   - Each stage carries an explicit count label (not colour-only).
 *   - prefers-reduced-motion respected.
 * Counts are bigint strings (BigInt-parsed). No money math in the bars (counts only);
 *   the abandoned cart value is shown as a formatted money KPI by the parent.
 * Empty: EmptyState on no_data / zero abandoned — never fabricates a stage.
 */

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  LabelList,
} from 'recharts';
import { ChartContainer, ChartTooltipContent } from '@/components/ui/chart';
import type { ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ShoppingBag } from 'lucide-react';

interface CheckoutFunnelChartProps {
  abandonedCount: string;       // bigint string
  discountAppliedCount: string; // bigint string
  withAddressCount: string;     // bigint string
  isLoading?: boolean;
  className?: string;
}

const CHART_CONFIG: ChartConfig = {
  count: { label: 'Checkouts', color: 'hsl(var(--chart-1))' },
};

function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function CheckoutFunnelChart({
  abandonedCount,
  discountAppliedCount,
  withAddressCount,
  isLoading,
  className,
}: CheckoutFunnelChartProps) {
  const reducedMotion = useReducedMotion();

  if (isLoading) {
    return (
      <div className={className} aria-busy="true" aria-label="Checkout funnel — loading">
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>
    );
  }

  const abandoned = Number(BigInt(abandonedCount));
  if (abandoned === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No abandoned checkouts yet"
          description="The funnel appears once Shopflo sends its first checkout_abandoned webhook."
          icon={<ShoppingBag className="h-8 w-8" />}
        />
      </div>
    );
  }

  const withAddress = Number(BigInt(withAddressCount));
  const discountApplied = Number(BigInt(discountAppliedCount));

  // Stepped stages — total abandoned, then the recovery-relevant slices.
  const chartData = [
    { stage: 'Abandoned', count: abandoned },
    { stage: 'Reached address', count: withAddress },
    { stage: 'Discount applied', count: discountApplied },
  ];

  const srTable = (
    <table className="sr-only" aria-label="Checkout funnel data table">
      <caption>
        Shopflo abandoned-checkout funnel — total abandoned, then those that reached the address step
        and those that had a discount applied
      </caption>
      <thead>
        <tr>
          <th scope="col">Stage</th>
          <th scope="col">Checkouts</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={row.stage}>
            <td>{row.stage}</td>
            <td>{row.count.toLocaleString('en-IN')}</td>
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
        className="h-56 w-full"
        aria-label="Checkout funnel chart — abandoned checkouts by stage"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 8, right: 56, left: 8, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              allowDecimals={false}
            />
            <YAxis
              type="category"
              dataKey="stage"
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              width={110}
            />
            <Tooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => `${Number(value).toLocaleString('en-IN')} checkouts`}
                />
              }
            />
            <Bar
              dataKey="count"
              fill="var(--color-count)"
              radius={[0, 4, 4, 0]}
              isAnimationActive={!reducedMotion}
              aria-label="Abandoned checkouts by stage"
            >
              <LabelList
                dataKey="count"
                position="right"
                formatter={(v) => (v == null ? '' : Number(v).toLocaleString('en-IN'))}
                className="fill-foreground text-[11px] tabular-nums"
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  );
}
