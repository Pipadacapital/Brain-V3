'use client';

/**
 * CodMixChart — CoD-vs-prepaid recognized-revenue mix.
 *
 * A single 100%-stacked horizontal bar splitting recognized revenue into net CoD and
 * prepaid. Net CoD is CoD AFTER RTO clawback (the honest contribution) — the parent
 * surfaces the gross-delivered → −clawback → net breakdown as money KPIs; this chart
 * is the at-a-glance share.
 *
 * A11y:
 *   - SVG carries role="img" + aria-label (via ChartContainer).
 *   - Screen-reader fallback: a visually-hidden <table> is the source of truth.
 *   - The two segments are distinguished by an explicit in-bar label (share %) + the
 *     SR-table + legend text — never colour alone.
 *   - prefers-reduced-motion respected.
 * Money: minor-unit bigint strings are formatted by the parent for the table; the bar
 *   geometry uses the minor-unit magnitudes (Number() of bigint is safe for chart width).
 *   When net CoD is negative (RTO clawback > delivered) we clamp the BAR width to 0 but
 *   render the honest negative value in the table + label (never hide a loss).
 * Empty: handled by the parent (no_data) — this renders only with has_data.
 */

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts';
import { ChartContainer, ChartTooltipContent, ChartLegendContent } from '@/components/ui/chart';
import type { ChartConfig } from '@/components/ui/chart';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';

interface CodMixChartProps {
  codNetMinor: string;   // bigint string (may be negative)
  prepaidMinor: string;  // bigint string
  codSharePct: string | null;
  currencyCode: CurrencyCode;
  className?: string;
}

const CHART_CONFIG: ChartConfig = {
  cod: { label: 'Net CoD', color: 'hsl(var(--chart-1))' },
  prepaid: { label: 'Prepaid', color: 'hsl(var(--chart-3))' },
};

function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function CodMixChart({
  codNetMinor,
  prepaidMinor,
  codSharePct,
  currencyCode,
  className,
}: CodMixChartProps) {
  const reducedMotion = useReducedMotion();

  const codNet = BigInt(codNetMinor);
  const prepaid = BigInt(prepaidMinor);

  // Bar geometry: clamp a negative net-CoD to 0 width (a loss has no positive share),
  // but the table + tooltip carry the honest signed value.
  const codWidth = Number(codNet < 0n ? 0n : codNet);
  const prepaidWidth = Number(prepaid < 0n ? 0n : prepaid);

  const chartData = [{ name: 'mix', cod: codWidth, prepaid: prepaidWidth }];

  const codFmt = formatMoneyDisplay(codNetMinor, currencyCode);
  const prepaidFmt = formatMoneyDisplay(prepaidMinor, currencyCode);
  const shareLabel = codSharePct === null ? '—' : `${codSharePct}%`;

  const srTable = (
    <table className="sr-only" aria-label="CoD vs prepaid mix data table">
      <caption>
        Confirmed revenue mix — net cash-on-delivery (after undelivered orders are taken back out) versus prepaid, and the CoD share
      </caption>
      <thead>
        <tr>
          <th scope="col">Channel</th>
          <th scope="col">Confirmed revenue</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Net CoD (CoD share {shareLabel})</td>
          <td>{codFmt}</td>
        </tr>
        <tr>
          <td>Prepaid</td>
          <td>{prepaidFmt}</td>
        </tr>
      </tbody>
    </table>
  );

  return (
    <div className={className}>
      {srTable}

      <ChartContainer
        config={CHART_CONFIG}
        className="h-28 w-full"
        aria-label={`CoD versus prepaid mix — net CoD ${codFmt}, prepaid ${prepaidFmt}, CoD share ${shareLabel}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 0, right: 8, left: 8, bottom: 0 }}
            stackOffset="expand"
          >
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="name" hide />
            <Tooltip
              content={
                <ChartTooltipContent
                  formatter={(_value, name) => {
                    if (name === 'cod') return `Net CoD — ${codFmt} (${shareLabel} share)`;
                    if (name === 'prepaid') return `Prepaid — ${prepaidFmt}`;
                    return '';
                  }}
                />
              }
            />
            <Legend content={<ChartLegendContent />} />
            <Bar
              dataKey="cod"
              stackId="mix"
              fill="var(--color-cod)"
              radius={[4, 0, 0, 4]}
              isAnimationActive={!reducedMotion}
              aria-label="Net CoD share of recognized revenue"
            />
            <Bar
              dataKey="prepaid"
              stackId="mix"
              fill="var(--color-prepaid)"
              radius={[0, 4, 4, 0]}
              isAnimationActive={!reducedMotion}
              aria-label="Prepaid share of recognized revenue"
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  );
}
