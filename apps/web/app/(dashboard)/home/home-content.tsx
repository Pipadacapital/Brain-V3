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
 *   2. Exec KPI row — 7 tiles, each: headline value + WoW% delta + 7-day sparkline + click-through
 *        Realized / AOV / LTV / Repeat / Blended ROAS / New customers / Delivery success rate
 *        (kpi-summary + executive-metrics + shipment-outcomes — all EXISTING endpoints)
 *   3. Revenue/orders trend — day | week | month grain toggle (revenue-timeseries + revenue-monthly)
 *   4. Top-3 insights teaser → deep /insights  (insights-briefing)
 *   5. Top channels by attributed revenue       (channel-roas, top 5 → ChannelRoasTable)
 *   6. Today's recent orders                     (OrdersListCard)
 *
 * Money: every amount is a bigint minor-unit string → formatMoneyDisplay(minor, ccy). Never /100.
 * Honest: each tile/card renders an em-dash or EmptyState (never a fabricated 0) when data is absent;
 * each widget shows its own FreshnessBadge from the endpoint's as_of where one is exposed.
 *
 * Deltas: each KPI carries a Week-over-Week % momentum chip — the last-7-day window vs the prior
 * 7-day window, computed from the WINDOWED executive-metrics / shipment-outcomes reads (current vs
 * prior). The headline VALUE stays the cumulative/all-time figure (with the coverage TimeframeBadge);
 * the delta is the recent momentum. A relative % delta is only shown when the prior window is non-zero
 * (no fabricated ±∞). Sparklines encode SHAPE only (last 7 days) from the day-grain timeseries —
 * series we cannot honestly derive render an em-dash, never a flat fabricated baseline.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  Lightbulb,
  Megaphone,
  ShoppingCart,
  Sparkles,
  TrendingUp,
} from 'lucide-react';

import { TabShell } from '@/components/ui/tab-shell';
import type { ExplainerPanelProps } from '@/components/ui/explainer-panel';
import { SectionCard } from '@/components/ui/section-card';
import { EmptyState } from '@/components/ui/empty-state';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { TimeframeBadge } from '@/components/ui/timeframe-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

import { FoundationHealthCard } from '@/components/dashboard/foundation-health-card';
import { TopActionsCard } from '@/components/dashboard/top-actions-card';
import { LiveIndicator } from '@/components/dashboard/live-indicator';
import { KpiTile, type DeltaDirection } from '@/components/analytics/kpi-tile';
import { TrendChart } from '@/components/analytics/trend-chart';
import { Sparkline } from '@/components/analytics/sparkline';
import { ChannelRoasTable } from '@/components/analytics/channel-roas-table';
import { OrdersListCard } from '@/components/analytics/orders-list-card';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';

import {
  useKpiSummary,
  useExecutiveMetrics,
  useRevenueTimeseries,
  useRevenueMonthly,
  useOrdersTimeseries,
  useShipmentOutcomes,
  useChannelRoas,
  useInsightsBriefing,
} from '@/lib/hooks/use-analytics';
import { useConnectionStatus } from '@/lib/hooks/use-dashboard';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import { cn } from '@/lib/utils';
import type { CurrencyCode } from '@brain/money';
import type {
  InsightDto,
  InsightKind,
  ExecutiveMetricDto,
  AnalyticsExecutiveMetricsResponse,
  AnalyticsShipmentOutcomesResponse,
  AnalyticsTimeseriesResponse,
  AnalyticsOrdersTimeseriesResponse,
  AnalyticsRevenueMonthlyResponse,
} from '@/lib/api/types';

/** The Home explainer — what each headline means, how it's computed, and how fresh it is. */
const HOME_EXPLAINER: ExplainerPanelProps = {
  title: 'Home — How is my business doing now?',
  description:
    "Your live executive snapshot: realized revenue, AOV, lifetime value, repeat rate, ROAS, new customers and delivery success — each with a week-over-week trend; the revenue trend at day/week/month grain; your top open opportunities/risks; your top channels by attributed revenue; and the latest orders as they land.",
  sections: [
    {
      heading: 'How to read this page',
      body:
        'Health and the next best action lead the page — a decision before a chart. The KPI row is your headline economics; each tile carries a week-over-week momentum chip (last 7 days vs the prior 7) and a 7-day sparkline, and clicks through to its full module. The trend chart switches between day, week and month grain. Anything without real data shows an honest empty state or an em-dash, never a fabricated zero.',
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
    {
      name: 'New customers',
      definition: 'Distinct buyers in the last 7 days.',
      howComputed:
        'Executive metrics distinct_customers over the last-7-day window. Em-dash when there are no orders in the window.',
    },
    {
      name: 'Delivery success rate',
      definition: 'Share of shipped parcels delivered (vs RTO/other) in the last 7 days.',
      howComputed:
        'Shipment outcomes delivered ÷ total over the last-7-day window (silver_shipment — GoKwik AWB + Shiprocket). Em-dash when nothing shipped.',
    },
    {
      name: 'Week-over-week delta',
      definition: 'Each KPI’s momentum: the last 7 days vs the prior 7 days.',
      howComputed:
        'Relative % change over the windowed executive-metrics / shipment-outcomes reads. Shown only when the prior window is non-zero (never a fabricated ±∞).',
    },
  ],
  refreshCadence:
    'Gold marts refresh on the Silver→Gold loop (~every 15 min); the KPI/trend tiles re-poll the BFF every 30–60s. Each widget shows its own served-at time, and reads "an unknown time ago" when an endpoint exposes no timestamp.',
  sources: [
    'Gold mv_gold_revenue_ledger (revenue, AOV)',
    'Executive metrics (LTV, repeat rate, ROAS, new customers)',
    'Shipment outcomes (delivery success rate)',
    'Channel ROAS ledger (top channels)',
    'Insights briefing (opportunities/risks)',
    'Bronze order feed (recent orders)',
  ],
};

const KIND_ICON: Record<InsightKind, React.ComponentType<{ className?: string }>> = {
  risk: AlertTriangle,
  opportunity: Lightbulb,
  trend: TrendingUp,
};

/** The brand's active attribution model — matches the analytics Attribution/Marketing default. */
const DEFAULT_MODEL = 'position_based' as const;

// ── Pure helpers (presentation math only — never re-aggregates raw rows) ─────────

/** Safe money format — returns null (→ honest em-dash / "No data") instead of throwing. */
function money(minor: string | null | undefined, ccy: string | null | undefined): string | null {
  if (minor == null || ccy == null) return null;
  try {
    return formatMoneyDisplay(minor, ccy as CurrencyCode);
  } catch {
    return null;
  }
}

/** Parse a numeric/bigint string to a finite number, or null. For ratios/shape only — never money display. */
function num(s: string | null | undefined): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The current last-7-day window and the prior 7-day window (for WoW deltas). */
function sevenDayWindows() {
  const today = new Date();
  const day = 86_400_000;
  return {
    cur: { from: isoDate(new Date(today.getTime() - 6 * day)), to: isoDate(today) },
    prior: {
      from: isoDate(new Date(today.getTime() - 13 * day)),
      to: isoDate(new Date(today.getTime() - 7 * day)),
    },
  };
}

interface DeltaChip {
  delta: string;
  direction: DeltaDirection;
}

/** Relative % change of cur vs prior. Honest null when either is absent or prior is 0 (no fabricated ±∞). */
function wowDelta(cur: number | null, prior: number | null): DeltaChip | undefined {
  if (cur == null || prior == null || !Number.isFinite(cur) || !Number.isFinite(prior)) return undefined;
  if (prior === 0) return undefined;
  const pct = ((cur - prior) / prior) * 100;
  if (!Number.isFinite(pct)) return undefined;
  const r = Math.round(pct * 10) / 10;
  const direction: DeltaDirection = r > 0 ? 'up' : r < 0 ? 'down' : 'flat';
  return { delta: `${r > 0 ? '+' : ''}${r.toFixed(1)}%`, direction };
}

/** First metric row of a windowed executive-metrics response (single currency per brand in M1). */
function execMetric(resp: AnalyticsExecutiveMetricsResponse | undefined): ExecutiveMetricDto | null {
  return resp?.state === 'has_data' ? resp.metrics[0] ?? null : null;
}

/** Delivery success % = delivered ÷ total. Null when no shipments (honest — never 0%). */
function deliveryRate(resp: AnalyticsShipmentOutcomesResponse | undefined): number | null {
  if (resp?.state !== 'has_data') return null;
  const total = num(resp.total);
  const delivered = num(resp.delivered);
  if (total == null || delivered == null || total === 0) return null;
  return (delivered / total) * 100;
}

/** Last-N realized series (one currency) for a sparkline — encodes shape only. */
function revenueSeries(resp: AnalyticsTimeseriesResponse | undefined): number[] {
  if (!resp || resp.state !== 'has_data') return [];
  const ccy = resp.buckets[0]?.currency_code;
  return resp.buckets
    .filter((b) => b.currency_code === ccy)
    .map((b) => Number(b.realized_minor))
    .filter((n) => Number.isFinite(n));
}

/** Last-N daily AOV series (realized ÷ orders) for a sparkline — encodes shape only. */
function aovSeries(resp: AnalyticsOrdersTimeseriesResponse | undefined): number[] {
  if (!resp || resp.state !== 'has_data') return [];
  const ccy = resp.buckets[0]?.currency_code;
  return resp.buckets
    .filter((b) => b.currency_code === ccy)
    .map((b) => {
      const c = Number(b.order_count);
      const r = Number(b.realized_minor);
      return c > 0 ? r / c : 0;
    })
    .filter((n) => Number.isFinite(n));
}

/**
 * Fold the per-(month, lifecycle_state) Gold monthly rows into the TrendChart bucket shape, so the
 * month grain reuses the SAME chart. Realized = Σ realized_value_minor per (month, currency); we have
 * no separate monthly provisional split, so provisional is honestly 0 at month grain. Exact bigint sum.
 */
function monthlyToTimeseries(
  resp: AnalyticsRevenueMonthlyResponse | undefined,
): AnalyticsTimeseriesResponse {
  if (!resp || resp.state !== 'has_data') {
    return { state: 'no_data', from: null, to: null, grain: 'month' };
  }
  const byKey = new Map<string, { month: string; ccy: string; realized: bigint }>();
  for (const r of resp.rows) {
    const key = `${r.period_month}|${r.currency_code}`;
    const e = byKey.get(key) ?? { month: r.period_month, ccy: r.currency_code, realized: 0n };
    e.realized += BigInt(r.realized_value_minor);
    byKey.set(key, e);
  }
  const buckets = Array.from(byKey.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((e) => ({
      bucket: `${e.month}-01`,
      currency_code: e.ccy,
      realized_minor: e.realized.toString(),
      provisional_minor: '0',
    }));
  if (buckets.length === 0) return { state: 'no_data', from: null, to: null, grain: 'month' };
  return {
    state: 'has_data',
    from: buckets[0].bucket,
    to: buckets[buckets.length - 1].bucket,
    grain: 'month',
    buckets,
  };
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
 * KpiCell — one clickable KPI tile: the KpiTile (value + WoW delta) plus a corner 7-day sparkline,
 * wrapped in a Link that deep-links to the KPI's full analytics module. The sparkline inherits the
 * delta direction's colour via currentColor (text-* on the parent), and shows an em-dash when there
 * is no honest 7-day series to draw.
 */
function KpiCell({
  href,
  moduleLabel,
  label,
  value,
  sublabel,
  isLoading,
  delta,
  sparkData,
  testId,
}: {
  href: string;
  moduleLabel: string;
  label: string;
  value: string | null;
  sublabel: string;
  isLoading: boolean;
  delta?: DeltaChip;
  sparkData: number[];
  testId: string;
}) {
  const sparkColor =
    delta?.direction === 'up'
      ? 'text-status-green-700'
      : delta?.direction === 'down'
        ? 'text-status-red-700'
        : 'text-muted-foreground';

  return (
    <Link
      href={href}
      aria-label={`${label} — open ${moduleLabel}`}
      className="group relative block h-full rounded-xl transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <KpiTile
        label={label}
        value={value}
        sublabel={sublabel}
        isLoading={isLoading}
        delta={delta?.delta ?? null}
        deltaDirection={delta?.direction}
        className="h-full"
        data-testid={testId}
      />
      {!isLoading && (
        <span className={cn('pointer-events-none absolute right-4 bottom-4', sparkColor)}>
          <Sparkline data={sparkData} ariaLabel={`${label} — last 7 days`} width={64} height={20} />
        </span>
      )}
    </Link>
  );
}

/**
 * ExecKpiRow — the headline economics, now 7 tiles. Realized + AOV come from kpi-summary; LTV/Repeat/
 * ROAS from executive-metrics; New customers from the WINDOWED executive-metrics (last-7d distinct
 * buyers); Delivery success from the WINDOWED shipment-outcomes (delivered ÷ total). Every tile carries
 * a WoW% delta (last 7d vs prior 7d) and a 7-day sparkline, and clicks through to its module.
 * Honest em-dash when a ratio's denominator is 0 (never 0/∞). Freshness anchored to kpi-summary as_of.
 */
function ExecKpiRow() {
  const windows = useMemo(() => sevenDayWindows(), []);

  // Headline (cumulative / all-time) values — unchanged sources.
  const { data: kpiData, isLoading: kpiLoading } = useKpiSummary();
  const { data: execData, isLoading: execLoading } = useExecutiveMetrics();

  // Windowed reads for the WoW deltas + the two inherently-windowed tiles.
  const { data: execCur, isLoading: execCurLoading } = useExecutiveMetrics(windows.cur);
  const { data: execPrior } = useExecutiveMetrics(windows.prior);
  const { data: shipCur, isLoading: shipCurLoading } = useShipmentOutcomes(windows.cur);
  const { data: shipPrior } = useShipmentOutcomes(windows.prior);

  // Day-grain 7-day series for the sparklines.
  const { data: revTs } = useRevenueTimeseries({ from: windows.cur.from, to: windows.cur.to, grain: 'day' });
  const { data: ordTs } = useOrdersTimeseries({ from: windows.cur.from, to: windows.cur.to, grain: 'day' });

  const kpi = kpiData?.state === 'has_data' ? kpiData.kpis[0] : null;
  const exec = execData?.state === 'has_data' ? execData.metrics[0] : null;
  const asOf = kpiData && 'as_of' in kpiData ? kpiData.as_of : undefined;
  const coverageStart = kpiData?.state === 'has_data' ? kpiData.coverage_start ?? null : null;
  const coverageEnd = kpiData?.state === 'has_data' ? kpiData.coverage_end ?? null : null;

  const ccy = (kpi?.currency_code ?? exec?.currency_code ?? 'INR') as CurrencyCode;

  // Realized can be transiently NEGATIVE when reversals finalize before their sales — floor the
  // headline to 0 and explain in the sublabel (a bare "−₹149" reads as a loss/bug).
  const realizedMinor = kpi ? BigInt(kpi.realized_minor) : null;
  const realizedNegative = realizedMinor !== null && realizedMinor < 0n;
  const realizedValue = kpi ? formatMoneyDisplay(realizedNegative ? '0' : kpi.realized_minor, ccy) : null;
  const realizedSublabel = realizedNegative ? 'No realized revenue yet — sales still settling' : 'recognised, ex-fees';

  const aovValue = kpi ? formatMoneyDisplay(kpi.aov_minor, ccy) : null;
  const ltvValue = exec?.ltv_minor != null ? formatMoneyDisplay(exec.ltv_minor, ccy) : exec ? '—' : null;
  const repeatValue = exec?.repeat_rate_pct != null ? `${exec.repeat_rate_pct}%` : exec ? '—' : null;
  const roasValue = exec?.roas_ratio != null ? `${exec.roas_ratio}×` : exec ? '—' : null;

  // Inherently-windowed tiles (last 7 days).
  const curM = execMetric(execCur);
  const newCustNum = num(curM?.distinct_customers);
  const newCustValue = newCustNum != null ? newCustNum.toLocaleString('en-IN') : null;
  const deliveryNum = deliveryRate(shipCur);
  const deliveryValue = deliveryNum != null ? `${deliveryNum.toFixed(1)}%` : null;

  // WoW deltas — windowed cur vs prior.
  const priorM = execMetric(execPrior);
  const realizedDelta = wowDelta(num(curM?.realized_minor), num(priorM?.realized_minor));
  const aovDelta = wowDelta(num(curM?.aov_minor), num(priorM?.aov_minor));
  const ltvDelta = wowDelta(num(curM?.ltv_minor), num(priorM?.ltv_minor));
  const repeatDelta = wowDelta(num(curM?.repeat_rate_pct), num(priorM?.repeat_rate_pct));
  const roasDelta = wowDelta(num(curM?.roas_ratio), num(priorM?.roas_ratio));
  const newCustDelta = wowDelta(newCustNum, num(priorM?.distinct_customers));
  const deliveryDelta = wowDelta(deliveryNum, deliveryRate(shipPrior));

  // Sparkline series (em-dash for metrics with no honest day-grain series).
  const realizedSpark = revenueSeries(revTs);
  const aovSpark = aovSeries(ordTs);

  const loading = kpiLoading || execLoading;

  return (
    <SectionCard
      title="Headline economics"
      description="Your business at a glance, in the order currency. Deltas compare the last 7 days with the prior 7."
      meta={
        <div className="flex flex-wrap items-center gap-2">
          <TimeframeBadge start={coverageStart} end={coverageEnd} data-testid="home-kpi-timeframe" />
          {asOf ? (
            <span className="text-xs text-muted-foreground">
              As of{' '}
              {new Date(`${asOf}T00:00:00Z`).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                timeZone: 'UTC',
              })}
            </span>
          ) : null}
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <KpiCell
          href="/analytics/revenue"
          moduleLabel="Revenue analytics"
          label="Realized Revenue"
          value={realizedValue}
          sublabel={realizedSublabel}
          isLoading={loading}
          delta={realizedDelta}
          sparkData={realizedSpark}
          testId="home-kpi-realized"
        />
        <KpiCell
          href="/analytics/orders"
          moduleLabel="Orders analytics"
          label="AOV"
          value={aovValue}
          sublabel="avg order value"
          isLoading={loading}
          delta={aovDelta}
          sparkData={aovSpark}
          testId="home-kpi-aov"
        />
        <KpiCell
          href="/retention"
          moduleLabel="Retention"
          label="LTV"
          value={ltvValue}
          sublabel="realized value / customer"
          isLoading={loading}
          delta={ltvDelta}
          sparkData={[]}
          testId="home-kpi-ltv"
        />
        <KpiCell
          href="/retention"
          moduleLabel="Retention"
          label="Repeat Rate"
          value={repeatValue}
          sublabel="customers with 2+ orders"
          isLoading={loading}
          delta={repeatDelta}
          sparkData={[]}
          testId="home-kpi-repeat-rate"
        />
        <KpiCell
          href="/analytics/spend"
          moduleLabel="Ad spend & ROAS"
          label="Blended ROAS"
          value={roasValue}
          sublabel="realized ÷ ad spend"
          isLoading={loading}
          delta={roasDelta}
          sparkData={[]}
          testId="home-kpi-roas"
        />
        <KpiCell
          href="/customers"
          moduleLabel="Customers"
          label="New customers"
          value={newCustValue}
          sublabel="distinct buyers · last 7d"
          isLoading={execCurLoading}
          delta={newCustDelta}
          sparkData={[]}
          testId="home-kpi-new-customers"
        />
        <KpiCell
          href="/analytics/logistics"
          moduleLabel="Logistics"
          label="Delivery success rate"
          value={deliveryValue}
          sublabel="delivered ÷ shipped · last 7d"
          isLoading={shipCurLoading}
          delta={deliveryDelta}
          sparkData={[]}
          testId="home-kpi-delivery-success"
        />
      </div>
    </SectionCard>
  );
}

type TrendGrain = 'day' | 'week' | 'month';

/** Day / week / month grain toggle for the revenue trend (mirrors the Revenue analytics page). */
function GrainToggle({ grain, onChange }: { grain: TrendGrain; onChange: (g: TrendGrain) => void }) {
  const opts: { id: TrendGrain; label: string }[] = [
    { id: 'day', label: 'Daily' },
    { id: 'week', label: 'Weekly' },
    { id: 'month', label: 'Monthly' },
  ];
  return (
    <fieldset className="flex gap-1 rounded-md border bg-card p-0.5 w-fit" aria-label="Chart grain selection">
      <legend className="sr-only">Select chart grain</legend>
      {opts.map((o) => (
        <label
          key={o.id}
          className={cn(
            'cursor-pointer rounded px-3 py-1 text-xs font-medium transition-colors',
            grain === o.id
              ? 'bg-secondary text-secondary-foreground'
              : 'bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
          )}
        >
          <input
            type="radio"
            name="home-trend-grain"
            value={o.id}
            checked={grain === o.id}
            onChange={() => onChange(o.id)}
            className="sr-only"
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * RevenueTrendSection — realized vs provisional revenue with a day/week/month grain toggle.
 * Day/week read the revenue-timeseries (with grain param); month folds the Gold monthly mart
 * (revenue-monthly) into the SAME chart shape. Reuses TrendChart's loading + honest empty state.
 */
function RevenueTrendSection({ asOf }: { asOf?: string | null }) {
  const [grain, setGrain] = useState<TrendGrain>('day');

  // Window the day/week reads (month ignores the range — it folds whole-history monthly rows).
  const range = useMemo(() => {
    const today = new Date();
    const days = grain === 'week' ? 83 : 29;
    const from = new Date(today.getTime() - days * 86_400_000);
    return { from: isoDate(from), to: isoDate(today) };
  }, [grain]);

  const tsGrain: 'day' | 'week' = grain === 'week' ? 'week' : 'day';
  const { data: tsData, isLoading: tsLoading } = useRevenueTimeseries({
    from: range.from,
    to: range.to,
    grain: tsGrain,
  });
  const { data: monthlyData, isLoading: monthlyLoading } = useRevenueMonthly();

  const chartData = grain === 'month' ? monthlyToTimeseries(monthlyData) : tsData;
  const chartLoading = grain === 'month' ? monthlyLoading : tsLoading;
  // TrendChart's grain only drives label formatting; month buckets render as their month-start date.
  const chartGrain: 'day' | 'week' = grain === 'month' ? 'week' : grain;

  const description =
    grain === 'month'
      ? 'Realized revenue per month, from the Gold monthly mart.'
      : grain === 'week'
        ? 'Realized vs provisional revenue over the last 12 weeks.'
        : 'Realized vs provisional revenue over the last 30 days.';

  return (
    <SectionCard
      title="Revenue trend"
      description={description}
      actions={<GrainToggle grain={grain} onChange={setGrain} />}
      meta={<FreshnessBadge timestamp={asOf} />}
    >
      <TrendChart data={chartData} isLoading={chartLoading} grain={chartGrain} />
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

/**
 * TopChannelsCard — the top 5 channels by attributed revenue, with spend + ROAS (ChannelRoasTable
 * over the channel-roas read, brand's active model). Deep-links to the full Marketing surface.
 * Honest empty state until attribution + ad spend have rows; ROAS reads n/a when a channel has no spend.
 */
function TopChannelsCard() {
  const { data, isLoading } = useChannelRoas({ model: DEFAULT_MODEL });
  const rows = data?.state === 'has_data' ? data.rows : [];
  // Top 5 by attributed revenue (the table re-orders the survivors by channel for stable rendering).
  const top5 = [...rows]
    .sort((a, b) => Number(b.attributed_minor) - Number(a.attributed_minor))
    .slice(0, 5);

  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          <Megaphone className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Top channels
        </span>
      }
      description="Your top 5 channels by attributed revenue, with ad spend and ROAS."
      meta={<FreshnessBadge timestamp={undefined} />}
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link href="/marketing" className="inline-flex items-center gap-1">
            View all <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      }
    >
      {isLoading ? (
        <div className="space-y-2" aria-busy="true" aria-label="Top channels — loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : top5.length === 0 ? (
        <EmptyState
          compact
          icon={<Megaphone className="h-5 w-5" />}
          title="No channel ROAS yet"
          description="Channel ROAS appears once attribution credit and ad spend have rows for this brand. Nothing is fabricated until the numbers are real."
        />
      ) : (
        <ChannelRoasTable rows={top5} className="w-full text-sm" />
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

      <TopChannelsCard />

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
