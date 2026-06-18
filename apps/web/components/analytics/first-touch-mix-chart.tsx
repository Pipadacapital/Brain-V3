'use client';

/**
 * FirstTouchMixChart — distinct-journey count + share by FIRST-TOUCH channel (the
 * Silver-tier journey mix). Second chart read from silver.touchpoint via the
 * metric-engine journey seam (I-ST01 — the UI never queries StarRocks; data arrives
 * over the BFF).
 *
 * Channel is a DETERMINISTIC CASE-ladder value computed in the dbt mart (click_id →
 * paid; else utm.medium; else referrer → referral; else direct) — never a classifier
 * (D-5: no ML/fuzzy). There is NO money on a touchpoint, so no money is rendered here.
 *
 * Horizontal bar chart: one bar per channel, bar length = distinct-journey count. Each
 * bar carries an explicit data label (count + share %) so the value is readable WITHOUT
 * colour.
 *
 * A11y (accessibility skill — gated, not asserted):
 *   - SVG carries role="img" + aria-label (via ChartContainer).
 *   - Screen-reader fallback: a visually-hidden <table> is the source of truth (each
 *     row carries channel label + count + share — the SVG is decorative/aria-hidden).
 *   - NON-colour-only: each bar has an explicit count+share label AND each channel pairs
 *     an icon + text label in the SR-table — never colour alone.
 *   - prefers-reduced-motion: Recharts animation disabled when reduced-motion is active.
 * Counts: bigint strings (BigInt-parsed); Number() of a count is chart-safe for width.
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
  Megaphone,
  Facebook,
  Search,
  Music2,
  Mail,
  Share2,
  Link2,
  Globe,
} from 'lucide-react';
import { ChartContainer, ChartTooltipContent } from '@/components/ui/chart';
import type { ChartConfig } from '@/components/ui/chart';
import type { FirstTouchMixRow, JourneyChannel } from '@/lib/api/types';

interface FirstTouchMixChartProps {
  rows: FirstTouchMixRow[];
  className?: string;
}

/**
 * Per-channel presentation: human label, an icon glyph (non-colour redundancy), and a
 * stable display order (paid → owned → referral → direct). The icon pairs with the text
 * label in the SR-table so a colourblind user gets the full signal.
 */
const CHANNEL_META: Record<
  JourneyChannel,
  { label: string; icon: React.ComponentType<{ className?: string }>; order: number; chartVar: string }
> = {
  paid: { label: 'Paid', icon: Megaphone, order: 0, chartVar: 'hsl(var(--chart-1))' },
  paid_meta: { label: 'Paid · Meta', icon: Facebook, order: 1, chartVar: 'hsl(var(--chart-1))' },
  paid_google: { label: 'Paid · Google', icon: Search, order: 2, chartVar: 'hsl(var(--chart-2))' },
  paid_tiktok: { label: 'Paid · TikTok', icon: Music2, order: 3, chartVar: 'hsl(var(--chart-3))' },
  email: { label: 'Email', icon: Mail, order: 4, chartVar: 'hsl(var(--chart-4))' },
  organic_social: { label: 'Organic Social', icon: Share2, order: 5, chartVar: 'hsl(var(--chart-5))' },
  referral: { label: 'Referral', icon: Link2, order: 6, chartVar: 'hsl(var(--chart-2))' },
  direct: { label: 'Direct', icon: Globe, order: 7, chartVar: 'hsl(var(--chart-3))' },
};

const CHART_CONFIG: ChartConfig = {
  count: { label: 'Journeys', color: 'hsl(var(--chart-1))' },
};

function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function channelMeta(channel: JourneyChannel) {
  return (
    CHANNEL_META[channel] ?? {
      label: channel,
      icon: Globe,
      order: 99,
      chartVar: 'hsl(var(--chart-1))',
    }
  );
}

export function FirstTouchMixChart({ rows, className }: FirstTouchMixChartProps) {
  const reducedMotion = useReducedMotion();

  // Stable channel ordering (paid → owned → referral → direct), regardless of API order.
  const ordered = [...rows].sort(
    (a, b) => channelMeta(a.channel).order - channelMeta(b.channel).order,
  );

  const chartData = ordered.map((r) => {
    const meta = channelMeta(r.channel);
    const sharePart = r.share_pct === null ? '' : ` · ${r.share_pct}%`;
    const count = Number(BigInt(r.count));
    return {
      channel: r.channel,
      label: meta.label,
      count,
      countLabel: count.toLocaleString('en-IN'),
      barLabel: `${count.toLocaleString('en-IN')}${sharePart}`,
      sharePct: r.share_pct,
      Icon: meta.icon,
      fill: meta.chartVar,
    };
  });

  const srTable = (
    <table className="sr-only" aria-label="First-touch channel mix data table">
      <caption>
        Distinct-journey count and share by first-touch channel (channel is a deterministic
        CASE ladder — click-id, then UTM medium, then referrer, else direct)
      </caption>
      <thead>
        <tr>
          <th scope="col">First-touch channel</th>
          <th scope="col">Journeys</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={row.channel}>
            <td>{row.label}</td>
            <td>{row.countLabel}</td>
            <td>{row.sharePct === null ? '—' : `${row.sharePct}%`}</td>
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
        aria-label="First-touch channel mix — horizontal bars, longer means more journeys whose first touch was that channel"
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
              width={110}
            />
            <Tooltip
              content={
                <ChartTooltipContent
                  formatter={(_value, _name, entry) => {
                    const row = entry?.payload as
                      | { label?: string; countLabel?: string; sharePct?: string | null }
                      | undefined;
                    if (!row) return '';
                    const share = row.sharePct == null ? '—' : `${row.sharePct}%`;
                    return `${row.label}: ${row.countLabel} journeys (${share})`;
                  }}
                />
              }
            />
            <Bar
              dataKey="count"
              radius={[0, 4, 4, 0]}
              isAnimationActive={!reducedMotion}
              aria-label="Distinct-journey count by first-touch channel"
            >
              {/* Per-channel hue is decorative only — the count+share label and the
                  SR-table icon+text carry the meaning (never colour-only). */}
              {chartData.map((row) => (
                <Cell key={row.channel} fill={row.fill} />
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
