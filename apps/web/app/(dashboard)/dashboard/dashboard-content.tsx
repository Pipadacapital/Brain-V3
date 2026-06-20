'use client';

/**
 * DashboardContent — client component for the upgraded Phase 1 analytics dashboard.
 * Fetches all analytics data client-side via react-query hooks.
 *
 * Layout:
 *   1. KPI tile row: Realized, Provisional, Orders, AOV, RTO Rate (5 tiles).
 *   2. 2-col: TrendChart (~2/3) + RecognitionDonut (1/3).
 *   3. 2-col: RecentActivity + ConnectionStatusCard (condensed).
 *   4. BrandSummaryCard (overview strip).
 *   5. OnboardingProgressCard (if relevant).
 *
 * A11y: each section has a landmark heading. Charts have SR fallback tables.
 * Money: all amounts via formatMoneyDisplay (minor units → locale string).
 * Honest empty: skeleton → empty-state → data. Never fabricated 0.
 */

import { BrandSummaryCard } from '@/components/dashboard/brand-summary-card';
import { FoundationHealthCard } from '@/components/dashboard/foundation-health-card';
import { ConnectionStatusCard } from '@/components/dashboard/connection-status-card';
import { LiveIndicator } from '@/components/dashboard/live-indicator';
import { OnboardingProgressCard } from '@/components/dashboard/onboarding-progress-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { TrendChart } from '@/components/analytics/trend-chart';
import { RecognitionDonut } from '@/components/analytics/recognition-donut';
import { RecentActivity } from '@/components/analytics/recent-activity';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useKpiSummary, useRevenueTimeseries, useRecognitionBreakdown, useRecentActivity } from '@/lib/hooks/use-analytics';
import { useConnectionStatus } from '@/lib/hooks/use-dashboard';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { TrendingUp, BarChart3, Activity, AlertTriangle } from 'lucide-react';

/**
 * DisconnectedBanner — honest notice when the active brand's connector is disconnected.
 * The already-ingested data is retained (append-only ledger), so persisting numbers
 * are expected; we say so plainly rather than letting them look "stuck".
 */
function DisconnectedBanner() {
  const { data } = useConnectionStatus();
  if (!data || data.connector_status !== 'disconnected') return null;
  return (
    <div
      role="status"
      data-testid="dashboard-disconnected-banner"
      className="flex items-start gap-3 rounded-md border border-status-amber-700/20 bg-status-amber-50 px-4 py-3"
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-status-amber-700" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-status-amber-700">
          Shopify disconnected — showing last-synced data
        </p>
        <p className="text-xs text-status-amber-700/80 mt-0.5">
          Your historical data is preserved. Reconnect to resume live updates.
        </p>
      </div>
      <Link href="/settings/connectors" className="ml-auto shrink-0">
        <Button size="sm" variant="outline">
          Reconnect
        </Button>
      </Link>
    </div>
  );
}

/**
 * KpiRow — renders 5 KPI tiles from the kpi-summary endpoint.
 */
function KpiRow() {
  const { data, isLoading } = useKpiSummary();

  const kpi = data?.state === 'has_data' ? data.kpis[0] : null;
  const ccy = (kpi?.currency_code ?? 'INR') as CurrencyCode;

  // Realized = finalized sales + reversals. It can be transiently NEGATIVE when reversals
  // finalize before their sales do (sales still inside the recognition window). A bare
  // "−₹149" reads as a loss/bug — so when realized < 0 we floor the headline to the
  // currency zero and explain in the sublabel (honest: there's no realized revenue YET).
  const realizedMinor = kpi ? BigInt(kpi.realized_minor) : null;
  const realizedNegative = realizedMinor !== null && realizedMinor < 0n;
  const realizedValue = kpi
    ? formatMoneyDisplay(realizedNegative ? '0' : kpi.realized_minor, ccy)
    : null;
  const realizedSublabel = realizedNegative
    ? 'No realized revenue yet — sales still settling'
    : 'ex-fees';
  const provisionalValue = kpi ? formatMoneyDisplay(kpi.provisional_minor, ccy) : null;
  const orderValue = kpi ? Number(BigInt(kpi.order_count)).toLocaleString('en-IN') : null;
  const aovValue = kpi ? formatMoneyDisplay(kpi.aov_minor, ccy) : null;
  const rtoValue = kpi ? `${kpi.rto_rate_pct}%` : null;

  return (
    <section aria-label="Key performance indicators">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Gross Realized"
          value={realizedValue}
          isLoading={isLoading}
          sublabel={realizedSublabel}
          data-testid="kpi-realized"
        />
        <KpiTile
          label="Provisional"
          value={provisionalValue}
          isLoading={isLoading}
          sublabel="not yet settled"
          data-testid="kpi-provisional"
        />
        <KpiTile
          label="Orders"
          value={orderValue}
          isLoading={isLoading}
          data-testid="kpi-orders"
        />
        <KpiTile
          label="AOV"
          value={aovValue}
          isLoading={isLoading}
          sublabel="avg order value"
          data-testid="kpi-aov"
        />
        <KpiTile
          label="RTO Rate"
          value={rtoValue}
          isLoading={isLoading}
          lowerIsBetter
          sublabel="return to origin"
          data-testid="kpi-rto-rate"
        />
      </div>
    </section>
  );
}

/**
 * TrendSection — TrendChart (2/3) + RecognitionDonut (1/3).
 */
function TrendSection() {
  const { data: trendData, isLoading: trendLoading } = useRevenueTimeseries();
  const { data: donutData, isLoading: donutLoading } = useRecognitionBreakdown();

  return (
    <section aria-label="Revenue trends and recognition">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" aria-hidden="true" />
              Revenue Trend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TrendChart data={trendData} isLoading={trendLoading} grain="day" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <BarChart3 className="h-4 w-4" aria-hidden="true" />
              Recognition States
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RecognitionDonut data={donutData} isLoading={donutLoading} />
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

/**
 * ActivitySection — RecentActivity (left) + ConnectionStatusCard (right).
 */
function ActivitySection() {
  const { data: activityData, isLoading: activityLoading } = useRecentActivity(15);

  return (
    <section aria-label="Recent activity and connection status">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Activity className="h-4 w-4" aria-hidden="true" />
              Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RecentActivity data={activityData} isLoading={activityLoading} />
          </CardContent>
        </Card>

        <div>
          <ConnectionStatusCard />
        </div>
      </div>
    </section>
  );
}

export function DashboardContent() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Your brand intelligence command center.
          </p>
        </div>
        {/* feat-realtime-ingestion-pipeline (Track C): honest near-real-time liveness.
            Reflects the primary dashboard query's real last-fetch — never a faked "Live". */}
        <LiveIndicator />
      </div>

      <DisconnectedBanner />
      {/* Foundation-first (P1): readiness verdict leads the dashboard — health before charts. */}
      <FoundationHealthCard />
      <KpiRow />
      <TrendSection />
      <ActivitySection />

      <div className="max-w-md">
        <BrandSummaryCard />
      </div>

      <div className="max-w-md">
        <OnboardingProgressCard />
      </div>
    </div>
  );
}
