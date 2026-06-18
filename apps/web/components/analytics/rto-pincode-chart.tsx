'use client';

/**
 * RtoPincodeChart — RTO% by destination pincode cohort (GoKwik AWB terminal states).
 *
 * Horizontal bar chart: one bar per pincode cohort, bar length = RTO rate %. The
 * underlying counts (terminal / RTO) drive the tooltip + the SR-table fallback.
 *
 * A11y:
 *   - SVG carries role="img" + aria-label (via ChartContainer).
 *   - Screen-reader fallback: a visually-hidden <table> is the source of truth.
 *   - Bars are NOT colour-only: each carries an explicit data label (RTO% + counts)
 *     and the SR-table carries the full verdict per cohort.
 *   - prefers-reduced-motion: Recharts animations disabled when reduced-motion is active.
 *   - "pincode pending" → honest note instead of a fabricated cohort split.
 * Counts/rates: rto_rate_pct is a 2dp string → parsed to a chart-safe number for the
 *   axis only; the counts are bigint strings (BigInt-parsed), never floats.
 * Empty: EmptyState on no_data / empty cohorts — never fabricates a 0% cohort.
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
import { PackageX } from 'lucide-react';
import type { CodRtoCohort } from '@/lib/api/types';

interface RtoPincodeChartProps {
  cohorts: CodRtoCohort[];
  pincodePending: boolean;
  isLoading?: boolean;
  className?: string;
}

const CHART_CONFIG: ChartConfig = {
  rto: { label: 'RTO %', color: 'hsl(var(--chart-2))' },
};

function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Parse a 2dp percentage string to a number for the axis only (display, not money). */
function pctToNumber(pct: string | null): number {
  if (pct === null) return 0;
  const n = Number(pct);
  return Number.isFinite(n) ? n : 0;
}

export function RtoPincodeChart({ cohorts, pincodePending, isLoading, className }: RtoPincodeChartProps) {
  const reducedMotion = useReducedMotion();

  if (isLoading) {
    return (
      <div className={className} aria-busy="true" aria-label="RTO by pincode — loading">
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (cohorts.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No terminal shipments yet"
          description="RTO rate appears once AWB shipments reach a terminal state (delivered or returned)."
          icon={<PackageX className="h-8 w-8" />}
        />
      </div>
    );
  }

  // When no pincode arrived (pincode_pending), the single 'unknown' cohort still carries
  // the overall RTO truth — we render it but caption it honestly.
  const chartData = cohorts.map((c) => ({
    pincode: c.pincode,
    rto: pctToNumber(c.rto_rate_pct),
    rtoLabel: c.rto_rate_pct === null ? '—' : `${c.rto_rate_pct}%`,
    terminal: c.terminal_count,
    rtoCount: c.rto_count,
  }));

  const srTable = (
    <table className="sr-only" aria-label="RTO rate by pincode data table">
      <caption>
        RTO rate by destination pincode — RTO shipments divided by all terminal shipments per cohort
        {pincodePending ? ' (pincode pending partner data — overall cohort only)' : ''}
      </caption>
      <thead>
        <tr>
          <th scope="col">Pincode</th>
          <th scope="col">RTO rate</th>
          <th scope="col">RTO shipments</th>
          <th scope="col">Terminal shipments</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={row.pincode}>
            <td>{row.pincode}</td>
            <td>{row.rtoLabel}</td>
            <td>{Number(BigInt(row.rtoCount)).toLocaleString('en-IN')}</td>
            <td>{Number(BigInt(row.terminal)).toLocaleString('en-IN')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className={className}>
      {srTable}

      {pincodePending && (
        <p className="mb-2 text-xs text-muted-foreground italic" role="note">
          Pincode breakdown pending partner data — showing the overall cohort only.
        </p>
      )}

      <ChartContainer
        config={CHART_CONFIG}
        className="h-64 w-full"
        aria-label="RTO rate by pincode chart — horizontal bars, longer means higher return rate"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 8, right: 48, left: 8, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
            <XAxis
              type="number"
              tickFormatter={(v) => `${v}%`}
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              domain={[0, 'dataMax']}
            />
            <YAxis
              type="category"
              dataKey="pincode"
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              width={72}
            />
            <Tooltip
              content={
                <ChartTooltipContent
                  formatter={(_value, _name, entry) => {
                    const row = entry?.payload as
                      | { rtoLabel?: string; rtoCount?: string; terminal?: string }
                      | undefined;
                    if (!row) return '';
                    const rtoN = Number(BigInt(row.rtoCount ?? '0')).toLocaleString('en-IN');
                    const termN = Number(BigInt(row.terminal ?? '0')).toLocaleString('en-IN');
                    return `${row.rtoLabel} RTO — ${rtoN} of ${termN} terminal`;
                  }}
                />
              }
            />
            <Bar
              dataKey="rto"
              fill="var(--color-rto)"
              radius={[0, 4, 4, 0]}
              isAnimationActive={!reducedMotion}
              aria-label="RTO rate percentage by pincode"
            >
              {/* Explicit data label so the bar is readable without colour. */}
              <LabelList
                dataKey="rtoLabel"
                position="right"
                className="fill-foreground text-[11px] tabular-nums"
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  );
}
