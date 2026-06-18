'use client';

/**
 * OrderStatusContent — the order-status-mix / fulfillment-funnel surface (Silver tier).
 *
 * The FIRST surface read from the new Silver analytics tier (dbt → StarRocks
 * silver.order_state), proving Silver → metric-engine → BFF → UI end-to-end. It reads
 * ONLY via the BFF endpoint /api/v1/analytics/order-status-mix (the metric-engine Silver
 * seam, I-ST01) — NEVER StarRocks/SQL directly, never an inlined COUNT in the client.
 *
 * Money discipline (I-S07 / D-7): every amount is a bigint-serialized minor-unit string
 * rendered via formatMoneyDisplay(minorString, currency_code) — NO /100, NO parseFloat.
 * Count/share math is integer-only (BigInt) — counts are bigint strings, share_pct is a
 * 2dp string from the engine (never re-divided with floats in the client).
 *
 * DEV-HONESTY: data_source comes from the BFF (never hardcoded). When the underlying
 * ledger rows are synthetic in dev, the BFF returns data_source='synthetic' and the
 * <SyntheticBadge/> renders; when a real source lands it returns 'live' and the badge
 * disappears with no UI change. A subtle "Powered by the Silver tier" label marks the
 * provenance of this surface.
 *
 * Honest states: skeleton (aria-busy), ErrorCard with request_id on error, and an honest
 * empty state linking /settings/connectors — never a fabricated zero.
 *
 * A11y: the section is a labelled region; the chart carries an SR-table fallback +
 * role=img; status/synthetic indicators are icon+label (never colour-only).
 */

import { useState } from 'react';
import Link from 'next/link';
import { Layers, ArrowRight, PackageSearch } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { OrderStatusMixChart } from '@/components/analytics/order-status-mix-chart';
import { useOrderStatusMix } from '@/lib/hooks/use-analytics';
import type { CurrencyCode } from '@brain/money';
import type {
  AnalyticsOrderStatusMixResponse,
  OrderStatusMixRow,
} from '@/lib/api/types';

type OrderStatusMixHasData = Extract<AnalyticsOrderStatusMixResponse, { state: 'has_data' }>;

/** Date-range presets (days). The range drives the BFF query + the URL-free local state. */
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

/**
 * Integer-only percentage of `numerator` over `total`, rendered as a 2dp string.
 * BigInt math (counts are bigint strings) — NO float division on the raw counts.
 * Returns null when total ≤ 0 (honest — never a fabricated 0%).
 */
function sharePct(numerator: bigint, total: bigint): string | null {
  if (total <= 0n) return null;
  // basis points = num * 10000 / total → 2dp string (e.g. 4250 → '42.50').
  const bps = (numerator * 10000n) / total;
  const whole = bps / 100n;
  const frac = bps % 100n;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

function SectionSkeleton() {
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

export function OrderStatusContent() {
  const [rangeKey, setRangeKey] = useState<RangeKey>('90');
  const preset = RANGE_PRESETS.find((p) => p.key === rangeKey) ?? RANGE_PRESETS[1];
  const { from, to } = rangeFor(preset.days);

  const { data, isLoading, error, refetch } = useOrderStatusMix({ from, to });

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-foreground">Order Status</h1>
          {/* Subtle provenance: this surface is powered by the new Silver tier. */}
          <span
            data-testid="order-status-silver-label"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Read from the Silver analytics tier (dbt → StarRocks) via the metric-engine."
          >
            <Layers className="h-3 w-3" aria-hidden="true" />
            Powered by the Silver tier
          </span>
        </div>
        <p className="text-muted-foreground mt-1">
          Order-status mix and fulfillment funnel — counts and share by lifecycle state
          (placed → confirmed → delivered, with cancelled / RTO / refunded), over a date range.
        </p>
      </div>

      <section aria-label="Order status mix" data-testid="order-status-section">
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

        {isLoading && <SectionSkeleton />}
        {!isLoading && error && <ErrorCard error={error} retry={refetch} />}

        {!isLoading && !error && data?.state === 'no_data' && <EmptyConnectCard />}

        {!isLoading && !error && data?.state === 'has_data' && <OrderStatusData data={data} />}
      </section>
    </div>
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
