'use client';

/**
 * SettlementsWaterfall — gross → (− fees) → net step-down waterfall (Razorpay Track C).
 *
 * Renders the settlement ladder: Gross Recognized at the top, each fee/tax/reserve/reversal
 * as a downward step, and Net Settled at the bottom. This is the "show our work" surface:
 * it makes the net-of-fees subtraction VISIBLE rather than just two KPI numbers.
 *
 * New file (settlements-* prefix) to avoid clashing with FRONTEND A's settlements-content.tsx
 * and with the orders/data-health chart agents' files.
 *
 * Waterfall idiom (Recharts): each bar is a 2-segment horizontal stack —
 *   - an invisible "base" segment (the running offset), fill=transparent
 *   - a visible "value" segment (the bar magnitude)
 * Gross/Net are full bars from 0; fee steps float between the prior and next running total.
 *
 * Money discipline (I-S07 / D-7): all inputs are bigint minor-unit strings. We do bigint
 * subtraction for the running total, then divide to MAJOR units ONLY for the chart axis
 * (charts need a Number). Every LABEL the user reads is formatMoneyDisplay(minorString) —
 * the float is internal to the SVG geometry, never shown. fees[].amount_minor is a POSITIVE
 * magnitude rendered as a downward (− ₹X) step.
 *
 * A11y (accessibility skill):
 *   - SVG carries role="img" + an aria-label summary (via ChartContainer).
 *   - Screen-reader fallback: a visually-hidden <table> beside the SVG is the source of truth,
 *     with each step's label + signed formatted amount + running total.
 *   - Steps are distinguished by an explicit text label + a ▲/▼ glyph + colour — never colour
 *     alone (gross/net are credits ▲, fees are debits ▼).
 *   - prefers-reduced-motion disables the bar animation.
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
  Cell,
} from 'recharts';
import { ChartContainer } from '@/components/ui/chart';
import type { ChartConfig } from '@/components/ui/chart';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { SettlementFee, SettlementFeeType } from '@/lib/api/types';

const FEE_LABELS: Record<SettlementFeeType, string> = {
  payment_fee: 'Processing fee (MDR)',
  settlement_tax: 'GST on fee',
  rolling_reserve_deduction: 'Rolling reserve',
  settlement_reversal: 'Refunds & chargebacks',
};

const MINOR_DIVISORS: Record<CurrencyCode, bigint> = { INR: 100n, AED: 100n, SAR: 100n };

interface SettlementsWaterfallProps {
  grossMinor: string;
  netMinor: string;
  fees: SettlementFee[];
  currencyCode: string;
  className?: string;
}

type StepKind = 'credit' | 'debit';

interface WaterfallStep {
  key: string;
  label: string;
  kind: StepKind;
  /** signed minor-unit string for the screen-reader table (− for debits). */
  signedMinor: string;
  /** running total (minor units) AFTER this step, for the SR table. */
  runningMinor: string;
  /** chart geometry (MAJOR units, for the SVG only — never read by the user). */
  base: number;
  value: number;
}

function minorToMajorNumber(minor: bigint, divisor: bigint): number {
  // Major-unit number for chart geometry only. Precision loss here is cosmetic (pixel
  // positions); every user-visible number comes from formatMoneyDisplay on the bigint.
  return Number(minor) / Number(divisor);
}

// Detect reduced-motion preference (matches the other analytics charts).
function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Dedicated waterfall tooltip — reads the raw WaterfallStep off the payload and renders
 * the signed, formatMoneyDisplay'd amount. Inline (not ChartTooltipContent) so the
 * transparent `base` series is excluded and the value is shown with a ▲/▼ glyph + colour
 * (never colour alone).
 */
function WaterfallTooltip({
  active,
  payload,
  ccy,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; payload?: WaterfallStep }>;
  ccy: CurrencyCode;
}) {
  if (!active || !payload?.length) return null;
  const entry = payload.find((p) => p.dataKey === 'value') ?? payload[0];
  const row = entry?.payload;
  if (!row) return null;
  const mag = row.signedMinor.startsWith('-') ? row.signedMinor.slice(1) : row.signedMinor;
  const glyph = row.kind === 'debit' ? '▼ −' : '▲';
  const colorClass = row.kind === 'debit' ? 'text-status-red-700' : 'text-foreground';
  return (
    <div
      className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md"
      role="status"
      aria-live="polite"
    >
      <p className="mb-1 font-medium text-foreground">{row.label}</p>
      <p className={`tabular-nums font-semibold ${colorClass}`}>
        {glyph} {formatMoneyDisplay(mag, ccy)}
      </p>
      <p className="mt-1 text-muted-foreground">
        Running: {formatMoneyDisplay(row.runningMinor, ccy)}
      </p>
    </div>
  );
}

export function SettlementsWaterfall({
  grossMinor,
  netMinor,
  fees,
  currencyCode,
  className,
}: SettlementsWaterfallProps) {
  const reducedMotion = useReducedMotion();
  const ccy = currencyCode as CurrencyCode;
  const divisor = MINOR_DIVISORS[ccy] ?? 100n;

  // Build the ladder in bigint, then project to major units for geometry.
  const gross = BigInt(grossMinor);
  const net = BigInt(netMinor);

  const steps: WaterfallStep[] = [];

  // 1) Gross — full bar from 0.
  steps.push({
    key: 'gross',
    label: 'Gross Revenue',
    kind: 'credit',
    signedMinor: grossMinor,
    runningMinor: grossMinor,
    base: 0,
    value: minorToMajorNumber(gross, divisor),
  });

  // 2) Each fee — a downward step floating from the prior running total.
  let running = gross;
  for (const fee of fees) {
    const mag = BigInt(fee.amount_minor); // positive magnitude
    const afterRunning = running - mag;
    const topMajor = minorToMajorNumber(running, divisor);
    const bottomMajor = minorToMajorNumber(afterRunning, divisor);
    steps.push({
      key: fee.type,
      label: FEE_LABELS[fee.type],
      kind: 'debit',
      signedMinor: `-${fee.amount_minor}`,
      runningMinor: afterRunning.toString(),
      base: Math.min(topMajor, bottomMajor),
      value: Math.abs(topMajor - bottomMajor),
    });
    running = afterRunning;
  }

  // 3) Net — full bar from 0 (the honest realized figure).
  steps.push({
    key: 'net',
    label: 'Net Settled',
    kind: 'credit',
    signedMinor: netMinor,
    runningMinor: netMinor,
    base: 0,
    value: minorToMajorNumber(net, divisor),
  });

  const config: ChartConfig = {
    value: { label: 'Amount', color: 'hsl(var(--chart-1))' },
  };

  const formatAxis = (v: number): string => {
    if (Math.abs(v) >= 1_00_000) return `${(v / 1_00_000).toFixed(1)}L`;
    if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
    return String(Math.round(v));
  };

  // Screen-reader fallback table — authoritative; every figure via formatMoneyDisplay.
  const srTable = (
    <table className="sr-only" aria-label="Settlement waterfall data table">
      <caption>
        Settlement ladder — gross recognized revenue, each deduction, and net settled
      </caption>
      <thead>
        <tr>
          <th scope="col">Step</th>
          <th scope="col">Amount</th>
          <th scope="col">Running total</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s) => (
          <tr key={s.key}>
            <td>{s.label}</td>
            <td>
              {s.kind === 'debit' ? '− ' : ''}
              {formatMoneyDisplay(
                s.signedMinor.startsWith('-') ? s.signedMinor.slice(1) : s.signedMinor,
                ccy,
              )}
            </td>
            <td>{formatMoneyDisplay(s.runningMinor, ccy)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className={className}>
      {srTable}

      <ChartContainer
        config={config}
        className="h-72 w-full"
        aria-label={`Settlement waterfall — gross ${formatMoneyDisplay(grossMinor, ccy)} down to net ${formatMoneyDisplay(netMinor, ccy)} after ${fees.length} deduction${fees.length === 1 ? '' : 's'}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={steps}
            margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
            barCategoryGap="20%"
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10 }}
              className="fill-muted-foreground"
              interval={0}
              angle={-15}
              textAnchor="end"
              height={56}
            />
            <YAxis
              tickFormatter={(v) => formatAxis(v as number)}
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              width={52}
            />
            <Tooltip
              cursor={{ fill: 'hsl(var(--muted))', fillOpacity: 0.3 }}
              content={<WaterfallTooltip ccy={ccy} />}
            />
            {/* Invisible base segment — positions each floating step. */}
            <Bar dataKey="base" stackId="wf" fill="transparent" isAnimationActive={false} />
            {/* Visible value segment — colour by step kind (paired with SR table + glyph). */}
            <Bar
              dataKey="value"
              stackId="wf"
              radius={[3, 3, 0, 0]}
              isAnimationActive={!reducedMotion}
            >
              {steps.map((s) => (
                <Cell
                  key={s.key}
                  fill={
                    s.kind === 'debit'
                      ? 'hsl(var(--chart-5))' // debits — red family
                      : s.key === 'net'
                        ? 'hsl(var(--chart-3))' // net — green family (the honest figure)
                        : 'hsl(var(--chart-1))' // gross — primary
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>

      {/* Visible legend — text + colour, never colour alone. */}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: 'hsl(var(--chart-1))' }}
            aria-hidden="true"
          />
          Gross (credit)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: 'hsl(var(--chart-5))' }}
            aria-hidden="true"
          />
          Deduction (debit ▼)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: 'hsl(var(--chart-3))' }}
            aria-hidden="true"
          />
          Net settled
        </span>
      </div>
    </div>
  );
}
