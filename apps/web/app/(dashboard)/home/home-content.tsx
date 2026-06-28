'use client';

/**
 * HomeContent — Tab #1 of the redesigned IA: "How is my business doing now?".
 *
 * The live executive snapshot. Composition over the EXISTING dashboard data layer — no new
 * analytics, no new endpoints. Re-homes the dashboard blocks under the TabShell frame so Home
 * gets the permanent "?" explainer, honest empty states, and a per-widget freshness stamp.
 *
 * Layout (health + a decision before charts — Brain rule "data foundation before dashboards"):
 *   1. Foundation health + Top actions       (FoundationHealthCard / TopActionsCard)
 *   2. Exec KPI row                            (kpi-summary + executive-metrics → KpiTile x5)
 *   3. 30-day revenue trend                    (revenue-timeseries → TrendChart)
 *   4. Top-3 insights teaser → deep /insights  (insights-briefing)
 *   5. Today's recent orders                   (OrdersListCard)
 *
 * Money: every amount is a bigint minor-unit string → formatMoneyDisplay(minor, ccy). Never /100.
 * Honest: each tile/card renders an em-dash or EmptyState (never a fabricated 0) when data is absent;
 * each widget shows its own FreshnessBadge from the endpoint's as_of where one is exposed.
 */

import Link from 'next/link';
import { AlertTriangle, ArrowRight, Lightbulb, ShoppingCart, Sparkles, TrendingUp } from 'lucide-react';

import { TabShell } from '@/components/ui/tab-shell';
import type { ExplainerPanelProps } from '@/components/ui/explainer-panel';
import { SectionCard } from '@/components/ui/section-card';
import { EmptyState } from '@/components/ui/empty-state';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

import { FoundationHealthCard } from '@/components/dashboard/foundation-health-card';
import { TopActionsCard } from '@/components/dashboard/top-actions-card';
import { LiveIndicator } from '@/components/dashboard/live-indicator';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { TrendChart } from '@/components/analytics/trend-chart';
import { OrdersListCard } from '@/components/analytics/orders-list-card';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';

import {
  useKpiSummary,
  useExecutiveMetrics,
  useRevenueTimeseries,
  useInsightsBriefing,
} from '@/lib/hooks/use-analytics';
import { useConnectionStatus } from '@/lib/hooks/use-dashboard';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { InsightDto, InsightKind } from '@/lib/api/types';

/** The Home explainer — what each headline means, how it's computed, and how fresh it is. */
const HOME_EXPLAINER: ExplainerPanelProps = {
  title: 'Home — How is my business doing now?',
  description:
    "Your live executive snapshot: realized revenue, AOV, lifetime value, repeat rate and ROAS, the 30-day revenue trend, your top open opportunities/risks, and the latest orders as they land.",
  sections: [
    {
      heading: 'How to read this page',
      body:
        'Health and the next best action lead the page — a decision before a chart. The KPI row is your headline economics; the trend shows the last 30 days; insights and recent orders are the live pulse. Anything without real data shows an honest empty state, never a fabricated zero.',
    },
  ],
  metrics: [
    {
      name: 'Realized revenue',
      definition: 'Recognised revenue from confirmed/finalized orders (ex-fees, in the order currency).',
      howComputed:
        'Gold revenue ledger (mv_gold_revenue_ledger), bigint minor units. Can read 0 while reversals settle ahead of their sales.',
    },
    {
      name: 'AOV',
      definition: 'Average order value over the snapshot window.',
      howComputed: 'KPI summary aov_minor = realized ÷ order count, per currency.',
    },
    {
      name: 'LTV',
      definition: 'Average realized lifetime value per customer.',
      howComputed: 'Executive metrics ltv_minor (registry-backed Gold marts). Em-dash when there are no customers yet.',
    },
    {
      name: 'Repeat rate',
      definition: 'Share of customers with 2 or more orders.',
      howComputed: 'Executive metrics repeat_rate_pct. Em-dash when the denominator is 0.',
    },
    {
      name: 'Blended ROAS',
      definition: 'Return on ad spend across all channels.',
      howComputed: 'Executive metrics roas_ratio = realized revenue ÷ ad spend. Em-dash when there is no spend.',
    },
  ],
  refreshCadence:
    'Gold marts refresh on the Silver→Gold loop (~every 15 min); the KPI/trend tiles re-poll the BFF every 30–60s. Each widget shows its own served-at time, and reads "an unknown time ago" when an endpoint exposes no timestamp.',
  sources: [
    'Gold mv_gold_revenue_ledger (revenue, AOV)',
    'Executive metrics (LTV, repeat rate, ROAS)',
    'Insights briefing (opportunities/risks)',
    'Bronze order feed (recent orders)',
  ],
};

const KIND_ICON: Record<InsightKind, React.ComponentType<{ className?: string }>> = {
  risk: AlertTriangle,
  opportunity: Lightbulb,
  trend: TrendingUp,
};

/** Safe money format — returns null (→ honest em-dash / "No data") instead of throwing. */
function money(minor: string | null | undefined, ccy: string | null | undefined): string | null {
  if (minor == null || ccy == null) return null;
  try {
    return formatMoneyDisplay(minor, ccy as CurrencyCode);
  } catch {
    return null;
  }
}

/**
 * DisconnectedBanner — honest notice when the active brand's connector is disconnected.
 * Already-ingested data is retained (append-only ledger), so the numbers below are last-synced,
 * not stuck. Re-homed from the old dashboard so Home keeps the same trust signal.
 */
function DisconnectedBanner() {
  const { data } = useConnectionStatus();
  if (!data || data.connector_status !== 'disconnected') return null;
  return (
    <Alert
      variant="warning"
      title="Shopify disconnected — showing last-synced data"
      data-testid="home-disconnected-banner"
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
 * ExecKpiRow — the headline economics: Realized, AOV, LTV, Repeat rate, Blended ROAS.
 * Realized + AOV come from kpi-summary; LTV/Repeat/ROAS from executive-metrics. Honest em-dash
 * when a ratio's denominator is 0 (never 0/∞). Freshness anchored to the kpi-summary as_of.
 */
function ExecKpiRow() {
  const { data: kpiData, isLoading: kpiLoading } = useKpiSummary();
  const { data: execData, isLoading: execLoading } = useExecutiveMetrics();

  const kpi = kpiData?.state === 'has_data' ? kpiData.kpis[0] : null;
  const exec = execData?.state === 'has_data' ? execData.metrics[0] : null;
  const asOf = kpiData && 'as_of' in kpiData ? kpiData.as_of : undefined;

  const ccy = (kpi?.currency_code ?? exec?.currency_code ?? 'INR') as CurrencyCode;

  // Realized can be transiently NEGATIVE when reversals finalize before their sales — a bare
  // "−₹149" reads as a loss/bug, so floor the headline to 0 and explain in the sublabel.
  const realizedMinor = kpi ? BigInt(kpi.realized_minor) : null;
  const realizedNegative = realizedMinor !== null && realizedMinor < 0n;
  const realizedValue = kpi ? formatMoneyDisplay(realizedNegative ? '0' : kpi.realized_minor, ccy) : null;
  const realizedSublabel = realizedNegative ? 'No realized revenue yet — sales still settling' : 'recognised, ex-fees';

  const aovValue = kpi ? formatMoneyDisplay(kpi.aov_minor, ccy) : null;
  const ltvValue = exec?.ltv_minor != null ? formatMoneyDisplay(exec.ltv_minor, ccy) : exec ? '—' : null;
  const repeatValue = exec?.repeat_rate_pct != null ? `${exec.repeat_rate_pct}%` : exec ? '—' : null;
  const roasValue = exec?.roas_ratio != null ? `${exec.roas_ratio}×` : exec ? '—' : null;

  const loading = kpiLoading || execLoading;

  return (
    <SectionCard
      title="Headline economics"
      description="Your business at a glance, in the order currency."
      meta={<FreshnessBadge timestamp={asOf} prefix="As of" />}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Realized Revenue"
          value={realizedValue}
          isLoading={loading}
          sublabel={realizedSublabel}
          data-testid="home-kpi-realized"
        />
        <KpiTile
          label="AOV"
          value={aovValue}
          isLoading={loading}
          sublabel="avg order value"
          data-testid="home-kpi-aov"
        />
        <KpiTile
          label="LTV"
          value={ltvValue}
          isLoading={loading}
          sublabel="realized value / customer"
          data-testid="home-kpi-ltv"
        />
        <KpiTile
          label="Repeat Rate"
          value={repeatValue}
          isLoading={loading}
          sublabel="customers with 2+ orders"
          data-testid="home-kpi-repeat-rate"
        />
        <KpiTile
          label="Blended ROAS"
          value={roasValue}
          isLoading={loading}
          sublabel="realized ÷ ad spend"
          data-testid="home-kpi-roas"
        />
      </div>
    </SectionCard>
  );
}

/**
 * RevenueTrendSection — last 30 days realized vs provisional. Reuses TrendChart, which renders
 * its own loading skeleton + honest empty state. Freshness from the briefing's gold-mart build time.
 */
function RevenueTrendSection({ asOf }: { asOf?: string | null }) {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 29);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const { data, isLoading } = useRevenueTimeseries({ from: iso(from), to: iso(today), grain: 'day' });

  return (
    <SectionCard
      title="Revenue trend"
      description="Realized vs provisional revenue over the last 30 days."
      meta={<FreshnessBadge timestamp={asOf} />}
    >
      <TrendChart data={data} isLoading={isLoading} grain="day" />
    </SectionCard>
  );
}

/** A single compact insight line in the Home teaser. */
function InsightTeaserRow({ insight }: { insight: InsightDto }) {
  const Icon = KIND_ICON[insight.kind];
  const impact = money(insight.impact_minor, insight.currency_code);
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="mt-0.5 text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{insight.title}</p>
        <p className="truncate text-xs text-muted-foreground">{insight.why}</p>
      </div>
      {impact && (
        <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
          {insight.kind === 'opportunity' ? '+' : ''}
          {impact}
        </span>
      )}
    </li>
  );
}

/**
 * InsightsTeaser — top-3 ranked opportunities/risks from the daily briefing, linking deep to the
 * full /insights Copilot surface (off-nav). Honest empty state until real insights exist.
 */
function InsightsTeaser() {
  const { data, isLoading } = useInsightsBriefing();
  const hasData = data?.state === 'has_data';
  const briefing = hasData ? data.briefing : null;
  const top3 = hasData ? data.insights.slice(0, 3) : [];

  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" /> What needs attention
          {briefing?.data_source === 'synthetic' && (
            <SyntheticBadge reason="Computed from synthetic demo data seeded into the Gold marts — never live data. It disappears once real data flows." />
          )}
        </span>
      }
      description={briefing?.headline ?? 'Your top open opportunities and risks.'}
      meta={<FreshnessBadge timestamp={briefing?.as_of} />}
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link href="/insights" className="inline-flex items-center gap-1">
            View all <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      }
      flush
    >
      {isLoading && <p className="p-5 text-sm text-muted-foreground">Analysing your commerce…</p>}
      {!isLoading && !hasData && (
        <div className="p-5">
          <EmptyState
            compact
            icon={<Lightbulb className="h-5 w-5" />}
            title="No insights yet"
            description="Connect a store and let orders, customers and spend flow. Brain surfaces opportunities and risks here automatically — no fabricated insights until the numbers are real."
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/settings/connectors">Connect a source</Link>
              </Button>
            }
          />
        </div>
      )}
      {!isLoading && hasData && top3.length === 0 && (
        <div className="p-5">
          <EmptyState
            compact
            icon={<Sparkles className="h-5 w-5" />}
            title="All clear"
            description="No open opportunities or risks right now. Brain will flag new ones here as your data shifts."
          />
        </div>
      )}
      {!isLoading && top3.length > 0 && (
        <ul className="divide-y divide-border px-5">
          {top3.map((insight) => (
            <InsightTeaserRow key={insight.id} insight={insight} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export function HomeContent() {
  // The briefing's as_of is the gold-mart build time — the most honest page-level "data as of"
  // anchor, shared by the trend + insights cards (both read the Gold marts).
  const { data: briefingData } = useInsightsBriefing();
  const briefingAsOf =
    briefingData?.state === 'has_data' ? briefingData.briefing.as_of ?? undefined : undefined;

  return (
    <TabShell
      title="Home"
      description="How is my business doing now?"
      explainer={HOME_EXPLAINER}
      actions={<LiveIndicator />}
      freshness={<FreshnessBadge timestamp={briefingAsOf} prefix="Data as of" />}
    >
      <DisconnectedBanner />

      {/* Foundation health + next best action lead the page — a decision before a chart. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <FoundationHealthCard />
        </div>
        <TopActionsCard />
      </div>

      <ExecKpiRow />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RevenueTrendSection asOf={briefingAsOf} />
        </div>
        <InsightsTeaser />
      </div>

      {/* Today's recent orders — OrdersListCard is self-contained (its own Card header, loading,
          honest empty state, and pagination). Rendered directly to avoid nested cards; the
          orders-list endpoint exposes no served-at timestamp, so freshness is honestly 'unknown'. */}
      <section aria-label="Recent orders" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="inline-flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
            <ShoppingCart className="h-4 w-4" aria-hidden="true" /> Recent orders
          </h2>
          <FreshnessBadge timestamp={undefined} />
        </div>
        <OrdersListCard />
      </section>
    </TabShell>
  );
}
