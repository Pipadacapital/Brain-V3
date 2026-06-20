'use client';

/**
 * RtoRiskChart — per-order RTO-risk distribution from GoKwik RTO-Predict.
 *
 * Each order is counted once, by its LATEST prediction over the window. The risk_flag is a VERBATIM
 * categorical bucket (High / Medium / Low / Control) — Brain never fabricates a numeric score. Shown
 * as a horizontal bar set, ordered high→control, colour-coded by severity but never colour-only
 * (each bar carries an explicit count label).
 *
 * A11y: SVG role=img + aria-label (ChartContainer); visually-hidden <table> is the SR source of
 * truth; prefers-reduced-motion respected. Empty: EmptyState on zero — never a fabricated bar.
 */
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
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
import { ShieldAlert } from 'lucide-react';

interface RtoRiskChartProps {
  high: string;
  medium: string;
  low: string;
  control: string;
  unknown: string;
  isLoading?: boolean;
  className?: string;
}

const CHART_CONFIG: ChartConfig = {
  count: { label: 'Orders', color: 'hsl(var(--chart-1))' },
};

// Severity colours — high (red) → control (muted). Order is fixed high→control.
const RISK_ROWS = [
  { key: 'High', color: 'hsl(var(--destructive))' },
  { key: 'Medium', color: 'hsl(38 92% 50%)' }, // amber
  { key: 'Low', color: 'hsl(142 71% 45%)' }, // green
  { key: 'Control', color: 'hsl(var(--muted-foreground))' },
] as const;

function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function RtoRiskChart({ high, medium, low, control, unknown, isLoading, className }: RtoRiskChartProps) {
  const reducedMotion = useReducedMotion();

  if (isLoading) {
    return (
      <div className={className} aria-busy="true" aria-label="RTO risk distribution — loading">
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>
    );
  }

  const counts: Record<string, number> = {
    High: Number(BigInt(high)),
    Medium: Number(BigInt(medium)),
    Low: Number(BigInt(low)),
    Control: Number(BigInt(control)),
  };
  const unknownN = Number(BigInt(unknown));
  const total = counts.High + counts.Medium + counts.Low + counts.Control + unknownN;

  if (total === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No RTO-risk predictions yet"
          description="The distribution appears once GoKwik returns RTO-Predict risk at checkout for your orders."
          icon={<ShieldAlert className="h-8 w-8" />}
        />
      </div>
    );
  }

  const chartData = RISK_ROWS.map((r) => ({ bucket: r.key, count: counts[r.key]!, color: r.color }));

  const srTable = (
    <table className="sr-only" aria-label="RTO risk distribution data table">
      <caption>Per-order RTO risk by category — counted by each order&apos;s latest prediction</caption>
      <thead>
        <tr>
          <th scope="col">Risk</th>
          <th scope="col">Orders</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={row.bucket}>
            <td>{row.bucket}</td>
            <td>{row.count.toLocaleString('en-IN')}</td>
          </tr>
        ))}
        {unknownN > 0 && (
          <tr>
            <td>Unknown</td>
            <td>{unknownN.toLocaleString('en-IN')}</td>
          </tr>
        )}
      </tbody>
    </table>
  );

  return (
    <div className={className}>
      {srTable}

      <ChartContainer config={CHART_CONFIG} className="h-56 w-full" aria-label="RTO risk distribution by category">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 56, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
            <XAxis type="number" tick={{ fontSize: 11 }} className="fill-muted-foreground" allowDecimals={false} />
            <YAxis type="category" dataKey="bucket" tick={{ fontSize: 11 }} className="fill-muted-foreground" width={80} />
            <Tooltip content={<ChartTooltipContent formatter={(value) => `${Number(value).toLocaleString('en-IN')} orders`} />} />
            <Bar dataKey="count" radius={[0, 4, 4, 0]} isAnimationActive={!reducedMotion} aria-label="Orders by RTO risk category">
              {chartData.map((row) => (
                <Cell key={row.bucket} fill={row.color} />
              ))}
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
