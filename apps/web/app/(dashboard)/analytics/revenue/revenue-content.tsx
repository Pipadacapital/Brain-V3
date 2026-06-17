'use client';

/**
 * RevenueContent — client component for the fuller revenue analytics view.
 */

import { useState } from 'react';
import { TrendingUp, BarChart3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { TrendChart } from '@/components/analytics/trend-chart';
import { RecognitionDonut } from '@/components/analytics/recognition-donut';
import {
  useKpiSummary,
  useRevenueTimeseries,
  useRecognitionBreakdown,
} from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import { cn } from '@/lib/utils';

type Grain = 'day' | 'week';

function GrainToggle({ grain, onChange }: { grain: Grain; onChange: (g: Grain) => void }) {
  return (
    <fieldset className="flex gap-1 rounded-md border p-0.5 w-fit" aria-label="Chart grain selection">
      <legend className="sr-only">Select chart grain</legend>
      {(['day', 'week'] as Grain[]).map((g) => (
        <label
          key={g}
          className={cn(
            'cursor-pointer rounded px-3 py-1 text-xs font-medium transition-colors',
            grain === g
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
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

export function RevenueContent() {
  const [grain, setGrain] = useState<Grain>('day');

  // Last 90 days window (stubbed — Phase 2 adds date-range picker)
  const toDate = new Date().toISOString().split('T')[0] as string;
  const fromDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0] as string;

  const { data: kpiData, isLoading: kpiLoading } = useKpiSummary();
  const { data: trendData, isLoading: trendLoading } = useRevenueTimeseries({
    from: fromDate,
    to: toDate,
    grain,
  });
  const { data: breakdownData, isLoading: breakdownLoading } = useRecognitionBreakdown();

  const kpi = kpiData?.state === 'has_data' ? kpiData.kpis[0] : null;
  const ccy = (kpi?.currency_code ?? 'INR') as CurrencyCode;

  const realizedValue = kpi ? formatMoneyDisplay(kpi.realized_minor, ccy) : null;
  const provisionalValue = kpi ? formatMoneyDisplay(kpi.provisional_minor, ccy) : null;
  const orderValue = kpi ? Number(BigInt(kpi.order_count)).toLocaleString('en-IN') : null;
  const aovValue = kpi ? formatMoneyDisplay(kpi.aov_minor, ccy) : null;
  const rtoValue = kpi ? `${kpi.rto_rate_pct}%` : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Revenue</h1>
        <p className="text-muted-foreground mt-1">
          Realized vs provisional revenue — last 90 days.
        </p>
      </div>

      {/* KPI tiles */}
      <section aria-label="Revenue KPIs">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile label="Gross Realized" value={realizedValue} isLoading={kpiLoading} sublabel="ex-fees" data-testid="rev-kpi-realized" />
          <KpiTile label="Provisional" value={provisionalValue} isLoading={kpiLoading} sublabel="not settled" data-testid="rev-kpi-provisional" />
          <KpiTile label="Orders" value={orderValue} isLoading={kpiLoading} data-testid="rev-kpi-orders" />
          <KpiTile label="AOV" value={aovValue} isLoading={kpiLoading} data-testid="rev-kpi-aov" />
          <KpiTile label="RTO Rate" value={rtoValue} isLoading={kpiLoading} lowerIsBetter data-testid="rev-kpi-rto" />
        </div>
      </section>

      {/* TrendChart with grain toggle */}
      <section aria-label="Revenue trend chart">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-4">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <TrendingUp className="h-4 w-4" aria-hidden="true" />
                Revenue Trend
              </CardTitle>
              <GrainToggle grain={grain} onChange={setGrain} />
            </div>
          </CardHeader>
          <CardContent>
            <TrendChart data={trendData} isLoading={trendLoading} grain={grain} className="h-72" />
          </CardContent>
        </Card>
      </section>

      {/* Recognition breakdown + detail table */}
      <section aria-label="Recognition breakdown and currency summary">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <BarChart3 className="h-4 w-4" aria-hidden="true" />
                Recognition States
              </CardTitle>
            </CardHeader>
            <CardContent>
              <RecognitionDonut data={breakdownData} isLoading={breakdownLoading} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Breakdown Detail
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
                <table className="w-full text-sm" aria-label="Recognition breakdown detail">
                  <thead>
                    <tr className="border-b">
                      <th scope="col" className="text-left font-medium text-muted-foreground pb-2">State</th>
                      <th scope="col" className="text-right font-medium text-muted-foreground pb-2">Amount</th>
                      <th scope="col" className="text-right font-medium text-muted-foreground pb-2">Orders</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdownData.breakdown.map((item) => (
                      <tr
                        key={item.label}
                        className="border-b last:border-0"
                      >
                        <td className="py-2 capitalize">{item.label}</td>
                        <td className="py-2 text-right tabular-nums font-medium">
                          {formatMoneyDisplay(item.amount_minor, item.currency_code as CurrencyCode)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">
                          {Number(BigInt(item.count)).toLocaleString('en-IN')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
