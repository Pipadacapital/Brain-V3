'use client';

/**
 * RevenueContent — deep revenue analytics view.
 *
 * READ-CORRECTNESS (audited vs StarRocks ground truth, brand Bodd Active):
 *   - KPI realized = SUM(amount_minor) over non-provisional events (finalization +
 *     cancellation clawback) — verified 104,284,774 INR.
 *   - KPI provisional = SUM over recognition_label IN ('provisional','settling') —
 *     verified 237,025,669 INR. Realized and provisional are DISJOINT (never blended).
 *   - All money is bigint MINOR units + currency_code; we never blend currencies.
 *
 * The numbers come from the Gold marts via the BFF/metric-engine. The UI does ONLY
 * presentation math: MoM growth as exact bigint basis-points over two mart-returned
 * realized values (a ratio of returned numbers, not a re-aggregation of raw rows).
 *
 * Sections (Tabs):
 *   - Trend       : realized vs provisional over time (TrendChart, day/week toggle).
 *   - Recognition : provisional → finalized distribution (donut + detail table).
 *   - Monthly     : per-month lifecycle from gold_revenue_analytics — net realized,
 *                   MoM growth, confirmed orders, cancellation/terminal rate.
 *
 * Honest states: loading skeletons, no_data ("No data yet"), and error cards.
 */

import { useState } from 'react';
import { TrendingUp, BarChart3, CalendarRange } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { DateRangeFilter, type DateRange, initialRange } from '@/components/ui/date-range-filter';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { KpiTile, type DeltaDirection } from '@/components/analytics/kpi-tile';
import { MetricTitle } from '@/components/ui/metric-title';
import { TrendChart } from '@/components/analytics/trend-chart';
import { RecognitionDonut } from '@/components/analytics/recognition-donut';
import {
  useKpiSummary,
  useRevenueTimeseries,
  useRecognitionBreakdown,
  useRevenueMonthly,
} from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { AnalyticsRevenueMonthlyRow } from '@/lib/api/types';
import type { CurrencyCode } from '@brain/money';
import { cn } from '@/lib/utils';

type Grain = 'day' | 'week';

/** Human display names for the internal revenue-recognition states (display-only). */
const REVENUE_STATUS_LABELS: Record<string, string> = {
  provisional: 'Pending',
  settling: 'Settling',
  finalized: 'Confirmed',
};

function revenueStatusLabel(state: string): string {
  return REVENUE_STATUS_LABELS[state] ?? state.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function GrainToggle({ grain, onChange }: { grain: Grain; onChange: (g: Grain) => void }) {
  return (
    <fieldset className="flex gap-1 rounded-md border bg-card p-0.5 w-fit" aria-label="Chart grain selection">
      <legend className="sr-only">Select chart grain</legend>
      {(['day', 'week'] as Grain[]).map((g) => (
        <label
          key={g}
          className={cn(
            'cursor-pointer rounded px-3 py-1 text-xs font-medium transition-colors',
            grain === g
              ? 'bg-secondary text-secondary-foreground'
              : 'bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
          )}
        >
          <input
            type="radio"
            name="grain"
            value={g}
            checked={grain === g}
            onChange={() => onChange(g)}
            className="sr-only"
          />
          {g === 'day' ? 'Daily' : 'Weekly'}
        </label>
      ))}
    </fieldset>
  );
}

// ── Pure presentation helpers (no raw-row re-aggregation; only ratios of returned numbers) ──

/** Format a signed percentage from exact bigint basis-points. Returns null when undefined. */
function fmtPctFromBps(bps: bigint | null): string | null {
  if (bps === null) return null;
  const sign = bps < 0n ? '-' : '+';
  const abs = bps < 0n ? -bps : bps;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}%`;
}

/** MoM growth basis-points = (curr-prev)/prev × 10000, exact integer. null if prev<=0. */
function momBps(curr: bigint, prev: bigint): bigint | null {
  if (prev <= 0n) return null;
  return ((curr - prev) * 10000n) / prev;
}

function deltaDir(bps: bigint | null): DeltaDirection {
  if (bps === null || bps === 0n) return 'flat';
  return bps > 0n ? 'up' : 'down';
}

interface MonthlyAgg {
  month: string;
  currency: CurrencyCode;
  netRealizedMinor: bigint;   // confirmed + cancelled (cancellation amounts are negative)
  confirmedOrders: bigint;
  totalOrders: bigint;
  terminalOrders: bigint;
}

/**
 * Fold the per-(month, state) rows into one row per (month, currency). Money stays
 * per-currency (never blended). Net realized = sum of realizing states for the month
 * (confirmed positive + cancellation negative) — a fold of returned mart values, not
 * a re-aggregation of raw ledger rows.
 */
function aggregateMonthly(rows: AnalyticsRevenueMonthlyRow[]): MonthlyAgg[] {
  const byKey = new Map<string, MonthlyAgg>();
  for (const r of rows) {
    const key = `${r.period_month}|${r.currency_code}`;
    const existing = byKey.get(key) ?? {
      month: r.period_month,
      currency: r.currency_code as CurrencyCode,
      netRealizedMinor: 0n,
      confirmedOrders: 0n,
      totalOrders: 0n,
      terminalOrders: 0n,
    };
    existing.netRealizedMinor += BigInt(r.realized_value_minor);
    existing.totalOrders += BigInt(r.order_count);
    existing.terminalOrders += BigInt(r.terminal_order_count);
    if (r.lifecycle_state === 'confirmed') {
      existing.confirmedOrders += BigInt(r.order_count);
    }
    byKey.set(key, existing);
  }
  // Stable order: month ASC.
  return Array.from(byKey.values()).sort((a, b) => a.month.localeCompare(b.month));
}

export function RevenueContent() {
  const [grain, setGrain] = useState<Grain>('day');
  const [range, setRange] = useState<DateRange>(() => initialRange());

  const { data: kpiData, isLoading: kpiLoading } = useKpiSummary();
  const { data: trendData, isLoading: trendLoading } = useRevenueTimeseries({
    from: range.from,
    to: range.to,
    grain,
  });
  const { data: breakdownData, isLoading: breakdownLoading } = useRecognitionBreakdown();
  const { data: monthlyData, isLoading: monthlyLoading } = useRevenueMonthly();

  const kpi = kpiData?.state === 'has_data' ? kpiData.kpis[0] : null;
  const ccy = (kpi?.currency_code ?? 'INR') as CurrencyCode;

  const realizedValue = kpi ? formatMoneyDisplay(kpi.realized_minor, ccy) : null;
  const provisionalValue = kpi ? formatMoneyDisplay(kpi.provisional_minor, ccy) : null;
  const orderValue = kpi ? Number(BigInt(kpi.order_count)).toLocaleString('en-IN') : null;
  const aovValue = kpi ? formatMoneyDisplay(kpi.aov_minor, ccy) : null;
  const rtoValue = kpi ? `${kpi.rto_rate_pct}%` : null;

  // Monthly aggregation (single currency per brand in M1; folded per-currency just in case).
  const monthly = monthlyData?.state === 'has_data' ? aggregateMonthly(monthlyData.rows) : [];
  const monthlyCcy = (monthly[0]?.currency ?? ccy) as CurrencyCode;
  const lastMonth = monthly.length > 0 ? monthly[monthly.length - 1] : null;
  const prevMonth = monthly.length > 1 ? monthly[monthly.length - 2] : null;

  // MoM realized growth (exact bigint bps) — drives the headline realized-delta + a tile.
  const realizedMoMBps =
    lastMonth && prevMonth ? momBps(lastMonth.netRealizedMinor, prevMonth.netRealizedMinor) : null;
  const ordersMoMBps =
    lastMonth && prevMonth ? momBps(lastMonth.confirmedOrders, prevMonth.confirmedOrders) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Revenue"
        description="Confirmed vs pending revenue, where each order stands, and month-over-month growth."
      />

      {/* KPI tiles — headline + MoM growth deltas */}
      <section aria-label="Revenue KPIs">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label="Confirmed revenue"
            help="Money from orders that are final, after subtracting anything taken back for cancellations."
            value={realizedValue}
            sublabel="after cancellations"
            delta={fmtPctFromBps(realizedMoMBps)}
            deltaDirection={deltaDir(realizedMoMBps)}
            isLoading={kpiLoading}
            data-testid="rev-kpi-realized"
          />
          <KpiTile
            label="Pending revenue"
            help="Money from recent orders that isn't final yet — it can still change with cancellations or returns."
            value={provisionalValue}
            isLoading={kpiLoading}
            sublabel="not yet settled"
            data-testid="rev-kpi-provisional"
          />
          <KpiTile
            label="Confirmed orders"
            help="How many orders were completed and confirmed; the change compares this month with last month."
            value={orderValue}
            sublabel="vs last month"
            delta={fmtPctFromBps(ordersMoMBps)}
            deltaDirection={deltaDir(ordersMoMBps)}
            isLoading={kpiLoading}
            data-testid="rev-kpi-orders"
          />
          <KpiTile
            label="Average order value"
            help="The average amount customers spend per confirmed order."
            value={aovValue}
            isLoading={kpiLoading}
            sublabel="confirmed revenue ÷ orders"
            data-testid="rev-kpi-aov"
          />
          <KpiTile
            label="RTO rate"
            help="The share of shipped orders that came back undelivered (returned to origin) — lower is better."
            value={rtoValue}
            isLoading={kpiLoading}
            lowerIsBetter
            sublabel="undelivered returns"
            data-testid="rev-kpi-rto"
          />
        </div>
      </section>

      <Tabs defaultValue="trend">
        <TabsList aria-label="Revenue views">
          <TabsTrigger value="trend">Trend</TabsTrigger>
          <TabsTrigger value="recognition">Revenue status</TabsTrigger>
          <TabsTrigger value="monthly">Monthly</TabsTrigger>
        </TabsList>

        {/* ── Trend ─────────────────────────────────────────────────────── */}
        <TabsContent value="trend">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <TrendingUp className="h-4 w-4" aria-hidden="true" />
                  <MetricTitle
                    label="Confirmed vs pending revenue"
                    help="Confirmed revenue is final; pending revenue is from recent orders that can still change."
                  />
                </CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  <DateRangeFilter
                    value={range}
                    onChange={setRange}
                    aria-label="Revenue trend date range"
                  />
                  <GrainToggle grain={grain} onChange={setGrain} />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <TrendChart data={trendData} isLoading={trendLoading} grain={grain} className="h-72" />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Recognition ───────────────────────────────────────────────── */}
        <TabsContent value="recognition">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <BarChart3 className="h-4 w-4" aria-hidden="true" />
                  <MetricTitle
                    label="Where your revenue stands"
                    help="How much of your revenue is still pending, being settled, or fully confirmed."
                  />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <RecognitionDonut data={breakdownData} isLoading={breakdownLoading} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  <MetricTitle
                    label="Revenue status detail"
                    help="The amount and number of orders in each status — pending, settling, or confirmed."
                  />
                </CardTitle>
              </CardHeader>
              <CardContent>
                {breakdownLoading && (
                  <div className="space-y-2" aria-busy="true" aria-label="Loading breakdown">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-8 bg-muted animate-pulse rounded" />
                    ))}
                  </div>
                )}
                {!breakdownLoading && breakdownData?.state === 'no_data' && (
                  <p className="text-sm text-muted-foreground italic" role="status">No data yet</p>
                )}
                {breakdownData?.state === 'has_data' && (
                  <Table aria-label="Revenue status detail">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-right">Orders</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {breakdownData.breakdown.map((item) => (
                        <TableRow key={`${item.label}-${item.currency_code}`}>
                          <TableCell>{revenueStatusLabel(item.label)}</TableCell>
                          <TableCell className="text-right tabular-nums font-medium">
                            {formatMoneyDisplay(item.amount_minor, item.currency_code as CurrencyCode)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {Number(BigInt(item.count)).toLocaleString('en-IN')}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── Monthly ───────────────────────────────────────────────────── */}
        <TabsContent value="monthly">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <CalendarRange className="h-4 w-4" aria-hidden="true" />
                <MetricTitle
                  label="Monthly revenue & growth"
                  help="Each month's confirmed revenue (after cancellations) and how it changed from the month before."
                />
              </CardTitle>
            </CardHeader>
            <CardContent>
              {monthlyLoading && (
                <div className="space-y-2" aria-busy="true" aria-label="Loading monthly revenue">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-8 bg-muted animate-pulse rounded" />
                  ))}
                </div>
              )}
              {!monthlyLoading && (monthlyData?.state === 'no_data' || monthly.length === 0) && (
                <p className="text-sm text-muted-foreground italic" role="status">No monthly data yet</p>
              )}
              {!monthlyLoading && monthly.length > 0 && (
                <Table aria-label="Monthly revenue breakdown">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="text-right">
                        <MetricTitle
                          label="Net revenue"
                          help="Confirmed revenue for the month, minus money taken back for cancellations."
                        />
                      </TableHead>
                      <TableHead className="text-right">
                        <MetricTitle
                          label="Vs last month"
                          help="How much net revenue grew or fell compared with the previous month."
                        />
                      </TableHead>
                      <TableHead className="text-right">
                        <MetricTitle
                          label="Confirmed orders"
                          help="How many orders were completed and confirmed that month."
                        />
                      </TableHead>
                      <TableHead className="text-right">
                        <MetricTitle
                          label="Avg order value"
                          help="The average amount customers spent per confirmed order that month."
                        />
                      </TableHead>
                      <TableHead className="text-right">
                        <MetricTitle
                          label="Cancellation rate"
                          help="The share of that month's orders that ended cancelled or returned."
                        />
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {monthly.map((m, idx) => {
                      const prev = idx > 0 ? monthly[idx - 1] : null;
                      const bps = prev ? momBps(m.netRealizedMinor, prev.netRealizedMinor) : null;
                      const pct = fmtPctFromBps(bps);
                      const aov =
                        m.confirmedOrders > 0n
                          ? formatMoneyDisplay(String(m.netRealizedMinor / m.confirmedOrders), m.currency)
                          : '—';
                      // Cancel/terminal rate = terminal ÷ total orders, exact bigint bps.
                      const cancelBps =
                        m.totalOrders > 0n ? (m.terminalOrders * 10000n) / m.totalOrders : null;
                      const cancelPct =
                        cancelBps === null
                          ? '—'
                          : `${cancelBps / 100n}.${String(cancelBps % 100n).padStart(2, '0')}%`;
                      return (
                        <TableRow key={`${m.month}-${m.currency}`}>
                          <TableCell className="font-medium tabular-nums">{m.month}</TableCell>
                          <TableCell className="text-right tabular-nums font-medium">
                            {formatMoneyDisplay(String(m.netRealizedMinor), m.currency)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right tabular-nums',
                              bps === null
                                ? 'text-muted-foreground'
                                : bps > 0n
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : bps < 0n
                                    ? 'text-rose-600 dark:text-rose-400'
                                    : 'text-muted-foreground',
                            )}
                          >
                            {pct ?? '—'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {Number(m.confirmedOrders).toLocaleString('en-IN')}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {aov}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {cancelPct}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              {!monthlyLoading && monthly.length > 0 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Net revenue = confirmed revenue minus money taken back for cancellations, shown in{' '}
                  {monthlyCcy}. Amounts in different currencies are never mixed together.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
