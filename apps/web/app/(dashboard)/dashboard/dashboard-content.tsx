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
import { TopActionsCard } from '@/components/dashboard/top-actions-card';
import { ConnectionStatusCard } from '@/components/dashboard/connection-status-card';
import { LiveIndicator } from '@/components/dashboard/live-indicator';
import { OnboardingProgressCard } from '@/components/dashboard/onboarding-progress-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { TrendChart } from '@/components/analytics/trend-chart';
import { RecognitionDonut } from '@/components/analytics/recognition-donut';
import { RecentActivity } from '@/components/analytics/recent-activity';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Alert } from '@/components/ui/alert';
import { useKpiSummary, useExecutiveMetrics, useRevenueTimeseries, useRecognitionBreakdown, useRecentActivity } from '@/lib/hooks/use-analytics';
import { useConnectionStatus } from '@/lib/hooks/use-dashboard';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

/**
 * DisconnectedBanner — honest notice when the active brand's connector is disconnected.
 * The already-ingested data is retained (append-only ledger), so persisting numbers
 * are expected; we say so plainly rather than letting them look "stuck".
 */
function DisconnectedBanner() {
  const { data } = useConnectionStatus();
  if (!data || data.connector_status !== 'disconnected') return null;
  return (
    <Alert
      variant="warning"
      title="Shopify disconnected — showing last-synced data"
      data-testid="dashboard-disconnected-banner"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>Your historical data is preserved. Reconnect to resume live updates.</span>
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link href="/settings/connectors">Reconnect</Link>
        </Button>
      </div>
    </Alert>
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
 * ExecutiveMetricsRow — H9 headline economics tiles (CAC, LTV, ROAS, Repeat-rate) from the
 * registry-backed Gold marts. Honest: each tile renders an em-dash when its ratio is null
 * (denominator 0 — never a fabricated 0 or ∞). The whole row hides when the brand has no Gold rows.
 */
function ExecutiveMetricsRow() {
  const { data, isLoading } = useExecutiveMetrics();
  const row = data?.state === 'has_data' ? data.metrics[0] : null;
  // Honest: no Gold executive rows yet (data foundation not built) → render nothing, no empty tiles.
  if (data && data.state === 'no_data') return null;

  const ccy = (row?.currency_code ?? 'INR') as CurrencyCode;
  const cacValue = row?.cac_minor != null ? formatMoneyDisplay(row.cac_minor, ccy) : row ? '—' : null;
  const ltvValue = row?.ltv_minor != null ? formatMoneyDisplay(row.ltv_minor, ccy) : row ? '—' : null;
  const roasValue = row?.roas_ratio != null ? `${row.roas_ratio}×` : row ? '—' : null;
  const repeatValue = row?.repeat_rate_pct != null ? `${row.repeat_rate_pct}%` : row ? '—' : null;

  return (
    <section aria-label="Unit economics">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label="CAC"
          value={cacValue}
          isLoading={isLoading}
          lowerIsBetter
          sublabel="customer acquisition cost"
          data-testid="kpi-cac"
        />
        <KpiTile
          label="LTV"
          value={ltvValue}
          isLoading={isLoading}
          sublabel="realized value per customer"
          data-testid="kpi-ltv"
        />
        <KpiTile
          label="Blended ROAS"
          value={roasValue}
          isLoading={isLoading}
          sublabel="realized ÷ ad spend"
          data-testid="kpi-roas"
        />
        <KpiTile
          label="Repeat Rate"
          value={repeatValue}
          isLoading={isLoading}
          sublabel="customers with 2+ orders"
          data-testid="kpi-repeat-rate"
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
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SectionCard title="Revenue trend" className="lg:col-span-2">
          <TrendChart data={trendData} isLoading={trendLoading} grain="day" />
        </SectionCard>

        <SectionCard
          title="Recognition states"
          description="How revenue is recognised across its lifecycle."
        >
          <RecognitionDonut data={donutData} isLoading={donutLoading} />
        </SectionCard>
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
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SectionCard title="Recent activity" className="lg:col-span-2">
          <RecentActivity data={activityData} isLoading={activityLoading} />
        </SectionCard>

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
      <PageHeader
        title="Dashboard"
        description="See what's true about your commerce — as your data comes in."
        actions={
          /* feat-realtime-ingestion-pipeline (Track C): honest near-real-time liveness.
             Reflects the primary dashboard query's real last-fetch — never a faked "Live". */
          <LiveIndicator />
        }
      />

      <DisconnectedBanner />

      {/* Foundation-first (P1): readiness verdict + next decision lead the dashboard —
          health and a decision before charts. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <FoundationHealthCard />
        </div>
        {/* "Decide" pillar (doc 09): the top actions lead the metrics — a decision, not a chart. */}
        <TopActionsCard />
      </div>

      <KpiRow />
      <ExecutiveMetricsRow />
      <TrendSection />
      <ActivitySection />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <BrandSummaryCard />
        <OnboardingProgressCard />
      </div>
    </div>
  );
}
