'use client';

/**
 * SpendContent — client component for the Ad Spend / ROAS analytics view (Slice 1 Track 4).
 *
 * Surfaces (all metrics from the registry via the Track-3 BFF; never inlined):
 *   - Blended ROAS KpiTile (realized revenue ÷ spend, per-currency, honest null when spend=0).
 *   - Total-spend KpiTiles per platform (Meta / Google) derived from the timeseries buckets.
 *   - Spend-over-time stacked area chart by platform, with grain (day/week) + platform filter.
 *   - Per-currency ROAS detail table (realized / spend / ratio) — the honest table behind the headline.
 *
 * Doctrine:
 *   - Money is BIGINT minor-unit strings → formatMoneyDisplay (locale-aware; never inline /100 math).
 *   - ROAS ratio is the BFF's exact decimal string — rendered directly, never re-divided with floats.
 *   - Honest states: 'no_data' → EmptyState + a Connect CTA; error → ErrorCard with the request_id.
 *   - Spend depends on a live ad connector; when there's no data we point the operator at the
 *     marketplace to connect Meta / Google rather than render a confident 0.
 */

import { useState } from 'react';
import Link from 'next/link';
import { TrendingUp, BarChart3, Plug } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { AdSpendTrendChart } from '@/components/analytics/ad-spend-trend-chart';
import { useAdSpendTimeseries, useBlendedRoas } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type {
  AnalyticsAdSpendTimeseriesResponse,
  AnalyticsBlendedRoasRow,
} from '@/lib/api/types';
import { cn } from '@/lib/utils';

type Grain = 'day' | 'week';
type PlatformFilter = 'all' | 'meta' | 'google_ads';

const PLATFORM_FILTERS: { value: PlatformFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'meta', label: 'Meta' },
  { value: 'google_ads', label: 'Google' },
];

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

function PlatformToggle({
  platform,
  onChange,
}: {
  platform: PlatformFilter;
  onChange: (p: PlatformFilter) => void;
}) {
  return (
    <fieldset className="flex gap-1 rounded-md border bg-card p-0.5 w-fit" aria-label="Platform filter">
      <legend className="sr-only">Filter by ad platform</legend>
      {PLATFORM_FILTERS.map((f) => (
        <label
          key={f.value}
          className={cn(
            'cursor-pointer rounded px-3 py-1 text-xs font-medium transition-colors',
            platform === f.value
              ? 'bg-secondary text-secondary-foreground'
              : 'bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
          )}
        >
          <input
            type="radio"
            name="platform"
            value={f.value}
            checked={platform === f.value}
            onChange={() => onChange(f.value)}
            className="sr-only"
          />
          {f.label}
        </label>
      ))}
    </fieldset>
  );
}

/** Sum spend per platform across the timeseries buckets (per primary currency). */
function sumByPlatform(
  data: AnalyticsAdSpendTimeseriesResponse | undefined,
): { currency: CurrencyCode; meta: bigint; google: bigint; total: bigint } | null {
  if (!data || data.state !== 'has_data' || data.buckets.length === 0) return null;
  const currency = (data.buckets[0]?.currency_code ?? 'INR') as CurrencyCode;
  let meta = 0n;
  let google = 0n;
  for (const b of data.buckets) {
    if (b.platform === 'meta') meta += BigInt(b.spend_minor);
    else if (b.platform === 'google_ads') google += BigInt(b.spend_minor);
  }
  return { currency, meta, google, total: meta + google };
}

export function SpendContent() {
  const [grain, setGrain] = useState<Grain>('day');
  const [platform, setPlatform] = useState<PlatformFilter>('all');

  // Last 35 days — matches the Track-3 default trailing window for ad spend.
  const toDate = new Date().toISOString().split('T')[0] as string;
  const fromDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0] as string;

  const {
    data: spendData,
    isLoading: spendLoading,
    error: spendError,
    refetch: refetchSpend,
  } = useAdSpendTimeseries({
    from: fromDate,
    to: toDate,
    grain,
    platform: platform === 'all' ? undefined : platform,
  });

  const {
    data: roasData,
    isLoading: roasLoading,
    error: roasError,
  } = useBlendedRoas({ from: fromDate, to: toDate });

  // Per-platform spend totals (from the current timeseries response).
  const totals = sumByPlatform(spendData);
  const metaSpendValue = totals ? formatMoneyDisplay(totals.meta.toString(), totals.currency) : null;
  const googleSpendValue = totals
    ? formatMoneyDisplay(totals.google.toString(), totals.currency)
    : null;
  const totalSpendValue = totals ? formatMoneyDisplay(totals.total.toString(), totals.currency) : null;

  // Blended ROAS headline — primary-currency row (Slice 1: single brand currency).
  const roasRows: AnalyticsBlendedRoasRow[] = roasData?.state === 'has_data' ? roasData.rows : [];
  const primaryRoas = roasRows[0] ?? null;
  // Render the exact decimal string directly (already 4 dp) — NEVER re-divide with floats.
  const roasValue = primaryRoas?.roas_ratio != null ? `${primaryRoas.roas_ratio}x` : null;

  // Hard error on the spend query → ErrorCard with the request_id (trace context surfaced).
  if (spendError) {
    return (
      <div className="space-y-6">
        <SpendHeader />
        <ErrorCard error={spendError} retry={refetchSpend} />
      </div>
    );
  }

  // Honest no-data: no spend ingested yet → point the operator at the marketplace to connect.
  const noSpend =
    !spendLoading && (!spendData || spendData.state === 'no_data');

  return (
    <div className="space-y-6">
      <SpendHeader />

      {noSpend ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title="No ad spend yet"
              description="Connect Meta Ads or Google Ads to start ingesting spend and see your blended ROAS."
              icon={<BarChart3 className="h-8 w-8" />}
              action={
                <Button asChild data-testid="spend-connect-cta">
                  <Link href="/settings/connectors">
                    <Plug className="mr-2 h-4 w-4" aria-hidden="true" />
                    Connect an ad platform
                  </Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* KPI tiles — blended ROAS headline + per-platform spend */}
          <section aria-label="Spend and ROAS KPIs">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiTile
                label="Blended ROAS"
                value={roasValue}
                isLoading={roasLoading}
                sublabel={
                  primaryRoas && primaryRoas.roas_ratio == null
                    ? 'no spend in window'
                    : 'realized ÷ spend'
                }
                data-testid="spend-kpi-roas"
              />
              <KpiTile
                label="Total Spend"
                value={totalSpendValue}
                isLoading={spendLoading}
                sublabel="last 35 days"
                lowerIsBetter
                data-testid="spend-kpi-total"
              />
              <KpiTile
                label="Meta Spend"
                value={metaSpendValue}
                isLoading={spendLoading}
                lowerIsBetter
                data-testid="spend-kpi-meta"
              />
              <KpiTile
                label="Google Spend"
                value={googleSpendValue}
                isLoading={spendLoading}
                lowerIsBetter
                data-testid="spend-kpi-google"
              />
            </div>
          </section>

          {/* Spend-over-time chart with grain + platform filters */}
          <section aria-label="Ad spend trend chart">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <BarChart3 className="h-4 w-4" aria-hidden="true" />
                    Spend Over Time
                  </CardTitle>
                  <div className="flex flex-wrap items-center gap-2">
                    <PlatformToggle platform={platform} onChange={setPlatform} />
                    <GrainToggle grain={grain} onChange={setGrain} />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <AdSpendTrendChart
                  data={spendData}
                  isLoading={spendLoading}
                  grain={grain}
                  className="h-72"
                />
              </CardContent>
            </Card>
          </section>

          {/* Per-currency ROAS detail — the honest table behind the headline */}
          <section aria-label="Blended ROAS by currency">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <TrendingUp className="h-4 w-4" aria-hidden="true" />
                  ROAS Detail
                </CardTitle>
              </CardHeader>
              <CardContent>
                {roasError ? (
                  <ErrorCard error={roasError} />
                ) : roasLoading ? (
                  <div className="space-y-2" aria-busy="true" aria-label="Loading ROAS detail">
                    {[1, 2].map((i) => (
                      <div key={i} className="h-8 bg-muted animate-pulse rounded" />
                    ))}
                  </div>
                ) : roasData?.state === 'no_data' || roasRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic" role="status">
                    No spend in this window — ROAS has no denominator yet.
                  </p>
                ) : (
                  <table className="w-full text-sm" aria-label="Blended ROAS by currency detail">
                    <thead>
                      <tr className="border-b">
                        <th scope="col" className="text-left font-medium text-muted-foreground pb-2">
                          Currency
                        </th>
                        <th scope="col" className="text-right font-medium text-muted-foreground pb-2">
                          Realized Revenue
                        </th>
                        <th scope="col" className="text-right font-medium text-muted-foreground pb-2">
                          Ad Spend
                        </th>
                        <th scope="col" className="text-right font-medium text-muted-foreground pb-2">
                          ROAS
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {roasRows.map((row) => {
                        const ccy = row.currency_code as CurrencyCode;
                        return (
                          <tr key={row.currency_code} className="border-b last:border-0">
                            <td className="py-2 font-medium">{row.currency_code}</td>
                            <td className="py-2 text-right tabular-nums">
                              {formatMoneyDisplay(row.realized_minor, ccy)}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {formatMoneyDisplay(row.spend_minor, ccy)}
                            </td>
                            <td className="py-2 text-right tabular-nums font-medium">
                              {row.roas_ratio != null ? (
                                `${row.roas_ratio}x`
                              ) : (
                                <span className="text-muted-foreground italic">n/a</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}

function SpendHeader() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground">Ad Spend &amp; ROAS</h1>
      <p className="text-muted-foreground mt-1">
        Meta &amp; Google ad spend over time, with blended return on ad spend — last 35 days.
      </p>
    </div>
  );
}
