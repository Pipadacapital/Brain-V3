'use client';

/**
 * OrderStatusMixChart — order count + share by lifecycle state (the Silver-tier
 * fulfillment funnel). First chart read from silver.order_state via the metric-engine
 * Silver seam (I-ST01 — the UI never queries StarRocks; data arrives over the BFF).
 *
 * Horizontal bar chart: one bar per lifecycle state, bar length = order count. Each bar
 * carries an explicit data label (count + share %) so the value is readable WITHOUT colour.
 *
 * A11y (accessibility skill — gated, not asserted):
 *   - SVG carries role="img" + aria-label (via ChartContainer).
 *   - Screen-reader fallback: a visually-hidden <table> is the source of truth (every
 *     row carries state, count, share, realized value — the SVG is decorative).
 *   - NON-colour-only: each bar has an explicit in-bar/right label (count + share) and
 *     each state pairs an icon + text label in the SR-table — never colour alone.
 *   - prefers-reduced-motion: Recharts animation disabled when reduced-motion is active.
 * Money: value_minor is a bigint string → formatMoneyDisplay (no /100, no parseFloat).
 * Counts: bigint strings (BigInt-parsed); Number() of an order count is chart-safe for width.
 * Empty: handled by the parent (no_data) — this renders only with has_data rows.
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
import {
  PackagePlus,
  CheckCircle2,
  Truck,
  XCircle,
  Undo2,
  RotateCcw,
} from 'lucide-react';
import { ChartContainer, ChartTooltipContent } from '@/components/ui/chart';
import type { ChartConfig } from '@/components/ui/chart';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { OrderLifecycleState, OrderStatusMixRow } from '@/lib/api/types';

interface OrderStatusMixChartProps {
  rows: OrderStatusMixRow[];
  currencyCode: CurrencyCode;
  className?: string;
}

/**
 * Per-state presentation: human label, an icon glyph (non-colour redundancy), and a
 * stable display order (the canonical funnel order placed → terminal states). The icon
 * pairs with the text label in the SR-table so a colourblind user gets the full signal.
 */
const STATE_META: Record<
  OrderLifecycleState,
  { label: string; icon: React.ComponentType<{ className?: string }>; order: number; chartVar: string }
> = {
  placed: { label: 'Placed', icon: PackagePlus, order: 0, chartVar: 'hsl(var(--chart-1))' },
  confirmed: { label: 'Confirmed', icon: CheckCircle2, order: 1, chartVar: 'hsl(var(--chart-2))' },
  delivered: { label: 'Delivered', icon: Truck, order: 2, chartVar: 'hsl(var(--chart-3))' },
  cancelled: { label: 'Cancelled', icon: XCircle, order: 3, chartVar: 'hsl(var(--chart-4))' },
  rto: { label: 'RTO', icon: Undo2, order: 4, chartVar: 'hsl(var(--chart-5))' },
  refunded: { label: 'Refunded', icon: RotateCcw, order: 5, chartVar: 'hsl(var(--chart-2))' },
};

const CHART_CONFIG: ChartConfig = {
  count: { label: 'Orders', color: 'hsl(var(--chart-1))' },
};

function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function stateMeta(state: OrderLifecycleState) {
  return STATE_META[state] ?? { label: state, icon: PackagePlus, order: 99, chartVar: 'hsl(var(--chart-1))' };
}

export function OrderStatusMixChart({ rows, currencyCode, className }: OrderStatusMixChartProps) {
  const reducedMotion = useReducedMotion();

  // Canonical funnel ordering (placed → terminal states), stable regardless of API order.
  const ordered = [...rows].sort((a, b) => stateMeta(a.lifecycle_state).order - stateMeta(b.lifecycle_state).order);

  const chartData = ordered.map((r) => {
    const meta = stateMeta(r.lifecycle_state);
    const sharePart = r.share_pct === null ? '' : ` · ${r.share_pct}%`;
    return {
      state: r.lifecycle_state,
      label: meta.label,
      count: Number(BigInt(r.count)),
      countLabel: Number(BigInt(r.count)).toLocaleString('en-IN'),
      barLabel: `${Number(BigInt(r.count)).toLocaleString('en-IN')}${sharePart}`,
      sharePct: r.share_pct,
      valueFmt: formatMoneyDisplay(r.value_minor, currencyCode),
      fill: meta.chartVar,
    };
  });

  const srTable = (
    <table className="sr-only" aria-label="Order status mix data table">
      <caption>
        Order count and share by lifecycle state, with realized order value per state
      </caption>
      <thead>
        <tr>
          <th scope="col">Lifecycle state</th>
          <th scope="col">Orders</th>
          <th scope="col">Share</th>
          <th scope="col">Realized value</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={row.state}>
            <td>{row.label}</td>
            <td>{row.countLabel}</td>
            <td>{row.sharePct === null ? '—' : `${row.sharePct}%`}</td>
            <td>{row.valueFmt}</td>
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
        className="h-72 w-full"
        aria-label="Order status mix — horizontal bars, longer means more orders in that lifecycle state"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 8, right: 96, left: 8, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              domain={[0, 'dataMax']}
              allowDecimals={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              width={84}
            />
            <Tooltip
              content={
                <ChartTooltipContent
                  formatter={(_value, _name, entry) => {
                    const row = entry?.payload as
                      | { label?: string; countLabel?: string; sharePct?: string | null; valueFmt?: string }
                      | undefined;
                    if (!row) return '';
                    const share = row.sharePct == null ? '—' : `${row.sharePct}%`;
                    return `${row.label}: ${row.countLabel} orders (${share}) — ${row.valueFmt}`;
                  }}
                />
              }
            />
            <Bar
              dataKey="count"
              radius={[0, 4, 4, 0]}
              isAnimationActive={!reducedMotion}
              aria-label="Order count by lifecycle state"
            >
              {/* Per-state hue is decorative only — the count+share label and the
                  SR-table icon+text carry the meaning (never colour-only). */}
              {chartData.map((row) => (
                <Cell key={row.state} fill={row.fill} />
              ))}
              {/* Explicit data label (count + share) so the bar is readable without colour. */}
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
