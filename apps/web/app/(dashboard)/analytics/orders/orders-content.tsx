'use client';

/**
 * OrdersContent — unified tabbed orders analytics surface.
 *
 * Consolidates two previously separate pages into one:
 *   - "Overview" tab  : volume view (KPI tiles + OrdersTrendChart + TopProductsCard +
 *                       OrdersListCard). Previously /analytics/orders.
 *   - "Status" tab    : lifecycle mix funnel (OrderStatusMixChart + share % + SyntheticBadge
 *                       + 30/90/180 range presets). Previously /analytics/order-status.
 *
 * Deep links: ?tab=status opens the Status tab directly (default = overview).
 * The old /analytics/order-status route redirects here via a server redirect in its page.tsx.
 *
 * DISCIPLINE:
 *   - Every metric is sourced from the metric-engine hooks (no ad-hoc aggregation).
 *   - Money (AOV) is a bigint minor-unit string → formatMoneyDisplay(minorStr, ccy). Never /100.
 *   - Counts are bigint strings → BigInt() parsed for display.
 *   - rto_rate_pct / share_pct are engine-provided strings; never re-divided here.
 *   - Honest states: 'no_data' → EmptyState; error → ErrorCard with request_id; never fabricates 0.
 *   - data_source comes from the BFF (never hardcoded); SyntheticBadge renders only on 'synthetic'.
 *   - A11y: labelled regions, SR-table chart fallback, icon+label not colour-only, aria-busy skeletons.
 */

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ShoppingCart, TrendingDown, Search, Layers, ArrowRight, PackageSearch } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { OrdersTrendChart } from '@/components/analytics/orders-trend-chart';
import { TopProductsCard } from '@/components/analytics/top-products-card';
import { OrdersListCard } from '@/components/analytics/orders-list-card';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { OrderStatusMixChart } from '@/components/analytics/order-status-mix-chart';
import { useOrderStats, useOrdersTimeseries, useOrderStatusMix } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type {
  AnalyticsOrderStatusMixResponse,
  OrderStatusMixRow,
} from '@/lib/api/types';
import { cn } from '@/lib/utils';

// ── Types ────────────────────────────────────────────────────────────────────

type Grain = 'day' | 'week';
type TabValue = 'overview' | 'status';
type OrderStatusMixHasData = Extract<AnalyticsOrderStatusMixResponse, { state: 'has_data' }>;

// ── Date-range presets (Status tab) ─────────────────────────────────────────

const RANGE_PRESETS = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '180', label: 'Last 180 days', days: 180 },
] as const;
type RangeKey = (typeof RANGE_PRESETS)[number]['key'];

function rangeFor(days: number): { from: string; to: string } {
  const to = new Date().toISOString().split('T')[0] as string;
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0] as string;
  return { from, to };
}

// ── Pure display helpers ──────────────────────────────────────────────────────

function formatCount(countStr: string): string {
  return Number(BigInt(countStr)).toLocaleString('en-IN');
}

/**
 * Integer-only percentage of `numerator` over `total`, rendered as a 2dp string.
 * BigInt math (counts are bigint strings) — NO float division on the raw counts.
 * Returns null when total <= 0 (honest — never a fabricated 0%).
 */
function sharePct(numerator: bigint, total: bigint): string | null {
  if (total <= 0n) return null;
  const bps = (numerator * 10000n) / total;
  const whole = bps / 100n;
  const frac = bps % 100n;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

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

/** Look up one order's captured economic breakdown by id (feat-shopify-order-depth). */
function OrderLookup() {
  const router = useRouter();
  const [orderId, setOrderId] = useState('');
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const id = orderId.trim();
        if (id) router.push(`/analytics/orders/${encodeURIComponent(id)}`);
      }}
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          placeholder="Look up order id…"
          aria-label="Order id"
          className="h-9 rounded-md border bg-card pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <button
        type="submit"
        className="h-9 rounded-md border bg-secondary px-3 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
        disabled={!orderId.trim()}
      >
        View
      </button>
    </form>
  );
}

function StatusSectionSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading order status mix…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

/** Honest empty card with a connect CTA (never a fabricated zero). */
function EmptyConnectCard() {
  return (
    <Card data-testid="order-status-empty">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <PackageSearch className="h-8 w-8" />
        </div>
        <div>
          <p className="font-medium text-foreground">No order data yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            Connect a commerce source to see your order-status mix and fulfillment funnel.
            The breakdown appears once orders flow into the Silver tier.
          </p>
        </div>
        <Link href="/settings/connectors">
          <Button variant="outline" size="sm">
            Connect a source
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

function OrderStatusData({ data }: { data: OrderStatusMixHasData }) {
  const ccy = data.currency_code as CurrencyCode;

  const total = BigInt(data.total);
  const terminal = BigInt(data.terminal_count);
  const terminalPct = sharePct(terminal, total);

  const deliveredRow: OrderStatusMixRow | undefined = data.by_state.find(
    (r) => r.lifecycle_state === 'delivered',
  );
  const deliveredCount = deliveredRow ? Number(BigInt(deliveredRow.count)) : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Total Orders"
          value={Number(total).toLocaleString('en-IN')}
          sublabel={`${data.from} → ${data.to}`}
          data-testid="order-status-kpi-total"
        />
        <KpiTile
          label="Terminal Share"
          value={terminalPct === null ? null : `${terminalPct}%`}
          sublabel="reached a final state"
          data-testid="order-status-kpi-terminal"
        />
        <KpiTile
          label="Delivered"
          value={deliveredCount.toLocaleString('en-IN')}
          sublabel="successfully fulfilled"
          data-testid="order-status-kpi-delivered"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Orders by lifecycle state
          </CardTitle>
        </CardHeader>
        <CardContent>
          <OrderStatusMixChart rows={data.by_state} currencyCode={ccy} />
        </CardContent>
      </Card>
    </div>
  );
}

// ── Overview tab content ──────────────────────────────────────────────────────

function OverviewTab() {
  const [grain, setGrain] = useState<Grain>('day');

  // Last 90 days window (Phase 2 adds a date-range picker). Server also
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

      {/* Paginated order list — Bronze latest-state, links to order detail. */}
      <OrdersListCard />

      {/* Top products — Silver order-line rollup. */}
      <TopProductsCard />
    </div>
  );
}

// ── Status tab content ────────────────────────────────────────────────────────

function StatusTab() {
  const [rangeKey, setRangeKey] = useState<RangeKey>('90');
  const preset = RANGE_PRESETS.find((p) => p.key === rangeKey) ?? RANGE_PRESETS[1];
  const { from, to } = rangeFor(preset.days);

  const { data, isLoading, error, refetch } = useOrderStatusMix({ from, to });

  return (
    <div className="space-y-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-foreground">Status breakdown</h2>
          {data?.state === 'has_data' && data.data_source === 'synthetic' && (
            <SyntheticBadge
              data-testid="order-status-synthetic-badge"
              reason="Order lifecycle is derived from the realized-revenue ledger; the cod_* delivery/RTO rows are synthetic in dev (real shape, synthetic source). A real partner sandbox is a platform follow-up."
            />
          )}
        </div>

        {/* Date-range selector — drives the BFF query (local UI state). */}
        <div
          role="group"
          aria-label="Date range"
          className="inline-flex rounded-md border border-border p-0.5"
        >
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setRangeKey(p.key)}
              aria-pressed={rangeKey === p.key}
              data-testid={`order-status-range-${p.key}`}
              className={
                rangeKey === p.key
                  ? 'rounded px-3 py-1 text-xs font-medium bg-foreground text-background'
                  : 'rounded px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground'
              }
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <StatusSectionSkeleton />}
      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}
      {!isLoading && !error && data?.state === 'no_data' && <EmptyConnectCard />}
      {!isLoading && !error && data?.state === 'has_data' && <OrderStatusData data={data} />}
    </div>
  );
}

// ── Root export ───────────────────────────────────────────────────────────────

export function OrdersContent() {
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const [tab, setTab] = useState<TabValue>(
    rawTab === 'status' ? 'status' : 'overview',
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Orders"
        description="Order volume, average order value, RTO rate, and lifecycle status mix."
        meta={
          <span
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Status tab reads from the Silver analytics tier (dbt → StarRocks) via the metric-engine."
          >
            <Layers className="h-3 w-3" aria-hidden="true" />
            Powered by the Silver tier
          </span>
        }
        actions={<OrderLookup />}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
        <TabsList aria-label="Orders views">
          <TabsTrigger value="overview">
            <ShoppingCart className="size-4" aria-hidden="true" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="status">
            <Layers className="size-4" aria-hidden="true" />
            Status
          </TabsTrigger>
        </TabsList>

        {/* Overview — volume view: KPI tiles, trend chart, products, order list. */}
        <TabsContent value="overview" className="space-y-6" data-testid="orders-tab-overview">
          <OverviewTab />
        </TabsContent>

        {/* Status — lifecycle mix funnel: status chart + range presets + SyntheticBadge. */}
        <TabsContent value="status" className="space-y-4" data-testid="orders-tab-status">
          <StatusTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
