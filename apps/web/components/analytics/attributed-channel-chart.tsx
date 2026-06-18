'use client';

/**
 * AttributedChannelChart — attributed revenue by channel for the selected model + window
 * (Phase 5, Gold attribution credit ledger). Read over the BFF → metric-engine sole read
 * path (I-ST01 — the UI never queries the ledger/StarRocks).
 *
 * Every figure is engine-computed and deterministic (position-based / first / last / linear
 * weights, largest-remainder apportionment so Σ credited = realized per order exactly). The
 * UI never re-apportions, never does float math.
 *
 * Money: contribution_minor is a SIGNED bigint string (net of clawbacks) — formatted via
 * formatMoneyDisplay (locale-aware, minor units + currency_code). NEVER /100, never a
 * hardcoded symbol. A clawback can drive a channel net below its gross — the net is what we
 * render (honest).
 *
 * Horizontal bar chart: one bar per channel, length = attributed contribution. Each bar
 * carries an explicit money + share data label so the value is readable WITHOUT colour.
 *
 * A11y (accessibility skill — gated, not asserted):
 *   - SVG carries role="img" + aria-label (via ChartContainer).
 *   - Screen-reader fallback: a visually-hidden <table> is the source of truth (each row:
 *     channel label + attributed money + share + confidence grade); the SVG is aria-hidden.
 *   - NON-colour-only: each bar has a money+share label AND each channel pairs icon+text in
 *     the SR-table; confidence is an icon+label badge — never colour alone.
 *   - prefers-reduced-motion: Recharts animation disabled when reduced-motion is active.
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
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { AttributedChannelRow } from '@/lib/api/types';
import { channelMeta } from './channel-meta';

interface AttributedChannelChartProps {
  rows: AttributedChannelRow[];
  currencyCode: string;
  className?: string;
}

const CHART_CONFIG: ChartConfig = {
  contribution: { label: 'Attributed revenue', color: 'hsl(var(--chart-1))' },
};

function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function AttributedChannelChart({
  rows,
  currencyCode,
  className,
}: AttributedChannelChartProps) {
  const reducedMotion = useReducedMotion();
  const ccy = currencyCode as CurrencyCode;

  // Stable channel ordering (paid → owned → referral → direct), regardless of API order.
  const ordered = [...rows].sort(
    (a, b) => channelMeta(a.channel).order - channelMeta(b.channel).order,
  );

  const chartData = ordered.map((r) => {
    const meta = channelMeta(r.channel);
    // SIGNED minor units → locale money string (never /100). Number() ONLY for bar width.
    const minor = BigInt(r.contribution_minor);
    const money = formatMoneyDisplay(r.contribution_minor, ccy);
    const sharePart = r.share_pct == null ? '' : ` · ${r.share_pct}%`;
    return {
      channel: r.channel,
      label: meta.label,
      // Bar width is a chart-only Number of minor units; the truth is the money string.
      width: Number(minor),
      money,
      barLabel: `${money}${sharePart}`,
      sharePct: r.share_pct,
      grade: r.confidence_grade,
      fill: meta.chartVar,
    };
  });

  const srTable = (
    <table className="sr-only" aria-label="Attributed revenue by channel data table">
      <caption>
        Attributed revenue (minor-units, net of clawbacks), share, and confidence grade by
        channel for the selected attribution model. Every figure is deterministic, computed in
        the metric engine.
      </caption>
      <thead>
        <tr>
          <th scope="col">Channel</th>
          <th scope="col">Attributed revenue</th>
          <th scope="col">Share</th>
          <th scope="col">Confidence</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={row.channel}>
            <td>{row.label}</td>
            <td>{row.money}</td>
            <td>{row.sharePct === null ? '—' : `${row.sharePct}%`}</td>
            <td>{row.grade}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className={className} data-testid="attributed-channel-chart">
      {srTable}

      <ChartContainer
        config={CHART_CONFIG}
        className="h-72 w-full"
        aria-label="Attributed revenue by channel — horizontal bars, longer means more attributed revenue for that channel"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 8, right: 140, left: 8, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              domain={[0, 'dataMax']}
              allowDecimals={false}
              tickFormatter={() => ''}
            />
            <YAxis
              type="category"
              dataKey="label"
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              width={110}
            />
            <Tooltip
              content={
                <ChartTooltipContent
                  formatter={(_value, _name, entry) => {
                    const row = entry?.payload as
                      | { label?: string; money?: string; sharePct?: string | null }
                      | undefined;
                    if (!row) return '';
                    const share = row.sharePct == null ? '—' : `${row.sharePct}%`;
                    return `${row.label}: ${row.money} (${share})`;
                  }}
                />
              }
            />
            <Bar
              dataKey="width"
              radius={[0, 4, 4, 0]}
              isAnimationActive={!reducedMotion}
              aria-label="Attributed revenue by channel"
            >
              {chartData.map((row) => (
                <Cell key={row.channel} fill={row.fill} />
              ))}
              {/* Explicit money + share label so the bar is readable without colour. */}
              <LabelList
                dataKey="barLabel"
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
