'use client';

/**
 * OrdersContent — client component for the orders analytics view.
 *
 * Mirrors revenue-content.tsx structure: a KPI tile row, a trend chart with a grain
 * toggle, an honest empty/loading/error path, and a per-currency detail table.
 *
 * DISCIPLINE:
 *   - Every metric is sourced from the Phase-2 hooks (useOrderStats / useOrdersTimeseries),
 *     which read the metric-engine sole-read-path. No ad-hoc aggregation here.
 *   - Money (AOV) is a bigint minor-unit string → formatMoneyDisplay(minorStr, ccy). Never /100.
 *   - Counts are bigint strings → BigInt() parsed for display.
 *   - rto_rate_pct is already a 0–100 percentage numeric string → render with a '%' suffix.
 *   - Honest states: 'no_data' → empty; error → ErrorCard with the request_id; never fabricates 0.
 */

import { useState } from 'react';
import { ShoppingCart, TrendingDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { OrdersTrendChart } from '@/components/analytics/orders-trend-chart';
import { useOrderStats, useOrdersTimeseries } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import { cn } from '@/lib/utils';

type Grain = 'day' | 'week';

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
            name="orders-grain"
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

function formatCount(countStr: string): string {
  return Number(BigInt(countStr)).toLocaleString('en-IN');
}

export function OrdersContent() {
  const [grain, setGrain] = useState<Grain>('day');

  // Last 90 days window (stubbed — Phase 2 adds a date-range picker). Server also
  // defaults to last 90 days when params are omitted; we pass explicit dates so the
  // grain toggle re-queries with a stable window.
  const toDate = new Date().toISOString().split('T')[0] as string;
  const fromDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0] as string;

  const {
    data: statsData,
    isLoading: statsLoading,
    error: statsError,
    refetch: refetchStats,
  } = useOrderStats();
  const {
    data: trendData,
    isLoading: trendLoading,
  } = useOrdersTimeseries({ from: fromDate, to: toDate, grain });

  // Primary currency = first stats row (M1 is single-currency INR). Multi-currency
  // breakdown is rendered in the detail table below.
  const stats = statsData?.state === 'has_data' ? statsData.stats : [];
  const primary = stats[0] ?? null;
  const ccy = (primary?.currency_code ?? 'INR') as CurrencyCode;

  const ordersValue = primary ? formatCount(primary.order_count) : null;
  const aovValue = primary ? formatMoneyDisplay(primary.aov_minor, ccy) : null;
  const rtoValue = primary ? `${primary.rto_rate_pct}%` : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Orders</h1>
        <p className="text-muted-foreground mt-1">
          Order volume, average order value, and RTO rate — last 90 days.
        </p>
      </div>

      {/* Honest error path — surfaces the request_id for support (trace context propagated). */}
      {statsError && (
        <ErrorCard error={statsError} retry={() => refetchStats()} />
      )}

      {/* KPI tiles — every value sourced from the order-stats metric. */}
      {!statsError && (
        <section aria-label="Order KPIs">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile
              label="Orders"
              value={ordersValue}
              isLoading={statsLoading}
              sublabel="settled + provisional"
              data-testid="orders-kpi-count"
            />
            <KpiTile
              label="AOV"
              value={aovValue}
              isLoading={statsLoading}
              sublabel="average order value"
              data-testid="orders-kpi-aov"
            />
            <KpiTile
              label="RTO Rate"
              value={rtoValue}
              isLoading={statsLoading}
              lowerIsBetter
              sublabel="returned to origin"
              data-testid="orders-kpi-rto"
            />
          </div>
        </section>
      )}

      {/* Orders-over-time trend with RTO overlay + grain toggle. */}
      <section aria-label="Orders trend chart">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-4">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <ShoppingCart className="h-4 w-4" aria-hidden="true" />
                Orders Over Time
              </CardTitle>
              <GrainToggle grain={grain} onChange={setGrain} />
            </div>
          </CardHeader>
          <CardContent>
            <OrdersTrendChart
              data={trendData}
              isLoading={trendLoading}
              grain={grain}
              className="h-72"
            />
          </CardContent>
        </Card>
      </section>

      {/* Per-currency stats detail — honest empty when no stats. */}
      {!statsError && (
        <section aria-label="Order stats by currency">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <TrendingDown className="h-4 w-4" aria-hidden="true" />
                Stats by Currency
              </CardTitle>
            </CardHeader>
            <CardContent>
              {statsLoading && (
                <div className="space-y-2" aria-busy="true" aria-label="Loading order stats">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-8 bg-muted animate-pulse rounded" />
                  ))}
                </div>
              )}
              {!statsLoading && statsData?.state === 'no_data' && (
                <EmptyState
                  title="No order data yet"
                  description="Order stats will appear once order data is available."
                  icon={<ShoppingCart className="h-8 w-8" />}
                />
              )}
              {!statsLoading && statsData?.state === 'has_data' && stats.length === 0 && (
                <EmptyState
                  title="No order data yet"
                  description="Order stats will appear once order data is available."
                  icon={<ShoppingCart className="h-8 w-8" />}
                />
              )}
              {statsData?.state === 'has_data' && stats.length > 0 && (
                <table className="w-full text-sm" aria-label="Order stats by currency">
                  <thead>
                    <tr className="border-b">
                      <th scope="col" className="text-left font-medium text-muted-foreground pb-2">
                        Currency
                      </th>
                      <th scope="col" className="text-right font-medium text-muted-foreground pb-2">
                        Orders
                      </th>
                      <th scope="col" className="text-right font-medium text-muted-foreground pb-2">
                        AOV
                      </th>
                      <th scope="col" className="text-right font-medium text-muted-foreground pb-2">
                        RTO Rate
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.map((s) => (
                      <tr key={s.currency_code} className="border-b last:border-0">
                        <td className="py-2 font-medium">{s.currency_code}</td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">
                          {formatCount(s.order_count)}
                        </td>
                        <td className="py-2 text-right tabular-nums font-medium">
                          {formatMoneyDisplay(s.aov_minor, s.currency_code as CurrencyCode)}
                        </td>
                        <td className="py-2 text-right tabular-nums">{s.rto_rate_pct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}
