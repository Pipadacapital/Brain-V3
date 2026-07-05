'use client';

/**
 * OperationsContent — the Fulfillment tab: "Where is revenue leaking in delivery?".
 *
 * Pure composition over EXISTING BFF reads (P1 — no new routes, no contract changes):
 *   • Alerts strip      → useInsightsBriefing (the deterministic risk feed; risk-kind only)
 *   • Courier table     → useShipmentOutcomes.by_courier (silver_shipment, Slice 2)
 *   • RTO by region     → useShipmentOutcomes.by_pincode → RtoPincodeChart (reused as-is)
 *   • Return funnel     → useReturnFunnel (silver_return, SR-10) — a SEPARATE lifecycle from
 *                         forward delivery; a "completed" return is delivered BACK to origin.
 *
 *   • Delivery time     → useDeliveryTime (gold_delivery_time, P3) — per-courier avg delivery
 *                         days + the fixed five-bucket day histogram (dispatch → delivered).
 *
 * Honesty rules (Brain): counts are bigint-as-string → Number(...).toLocaleString (NOT money,
 * never /100); avg_delivery_days is a behavioral double (NOT money — no /100); every panel
 * renders an honest EmptyState / em-dash, never a fabricated zero; SyntheticBadge shows
 * whenever the source reports data_source='synthetic'.
 *
 * Freshness: the page-level FreshnessBadge uses the briefing's gold-mart build time (as_of) —
 * the most honest shared "data as of" anchor; per-section reads share the same medallion.
 */

import { useState } from 'react';
import Link from 'next/link';
import {
  Truck,
  RotateCcw,
  MapPin,
  ArrowRight,
  AlertTriangle,
  ShieldCheck,
  Timer,
} from 'lucide-react';

import { TabShell } from '@/components/ui/tab-shell';
import type { ExplainerPanelProps } from '@/components/ui/explainer-panel';
import { SectionCard } from '@/components/ui/section-card';
import { EmptyState } from '@/components/ui/empty-state';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { DateRangeFilter, type DateRange, initialRange } from '@/components/ui/date-range-filter';
import { TableSearch, matchesQuery } from '@/components/ui/table-search';

import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { RtoPincodeChart } from '@/components/analytics/rto-pincode-chart';

import {
  useShipmentOutcomes,
  useReturnFunnel,
  useInsightsBriefing,
  useDeliveryTime,
} from '@/lib/hooks/use-analytics';
import type {
  AnalyticsShipmentOutcomesResponse,
  AnalyticsReturnFunnelResponse,
  CodRtoCohort,
  DeliveryTimeCourier,
  InsightDto,
  InsightSeverity,
} from '@/lib/api/types';

type ShipmentHasData = Extract<AnalyticsShipmentOutcomesResponse, { state: 'has_data' }>;
type ReturnHasData = Extract<AnalyticsReturnFunnelResponse, { state: 'has_data' }>;

const OPERATIONS_EXPLAINER: ExplainerPanelProps = {
  title: 'Operations — Where is revenue leaking in delivery?',
  description:
    'The fulfillment surface: which couriers and regions drive return-to-origin (RTO), how returns move through their own journey, and the open delivery risks worth acting on. Counted exactly from the tracking updates your logistics sources send (GoKwik, Shiprocket).',
  sections: [
    {
      heading: 'How to read this page',
      body:
        'RTO is revenue that shipped but came back — pure leakage. The courier and region tables rank where it concentrates so you can renegotiate or restrict COD. Returns are a SEPARATE journey: a "completed" return is delivered BACK to you, never a sale. Counts are exact; anything without data shows an honest empty state, never a made-up zero.',
    },
  ],
};

const RETURN_CLASS_LABEL: Record<string, string> = {
  return_initiated: 'Initiated',
  return_in_transit: 'In transit',
  return_delivered: 'Delivered to origin',
  return_completed: 'Completed / refunded',
  none: 'Unclassified',
};

const OPERATIONS_RANGE_PRESETS = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '180', label: 'Last 180 days', days: 180 },
] as const;

/** Count formatter — these are bigint-as-string shipment/return counts, NOT money. */
function num(s: string): string {
  return Number(s).toLocaleString('en-IN');
}

/** Risk severity → Alert variant (status is text+icon, never colour-only). */
const SEVERITY_VARIANT: Record<InsightSeverity, 'destructive' | 'warning' | 'info'> = {
  high: 'destructive',
  medium: 'warning',
  low: 'info',
  info: 'info',
};

// ── Alerts strip (insights-briefing — risk-kind only) ──────────────────────────

function AlertsStrip() {
  const { data, isLoading } = useInsightsBriefing();
  const hasData = data?.state === 'has_data';
  const briefing = hasData ? data.briefing : null;
  // The fulfillment page surfaces the deterministic RISK feed as a "what needs attention"
  // strip. We never fabricate alerts — only what the briefing reports.
  const risks: InsightDto[] = hasData
    ? data.insights.filter((i) => i.kind === 'risk').slice(0, 3)
    : [];

  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
          Open risks
          {briefing?.data_source === 'synthetic' && (
            <SyntheticBadge reason="Calculated from sample demo data, not your live sales. It disappears once real data flows." />
          )}
        </span>
      }
      description={briefing?.headline ?? 'Delivery and revenue risks worth acting on first.'}
      meta={<FreshnessBadge timestamp={briefing?.as_of} />}
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link href="/insights" className="inline-flex items-center gap-1">
            View all <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </Button>
      }
    >
      {isLoading && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading risks…">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}

      {!isLoading && risks.length === 0 && (
        <EmptyState
          compact
          icon={<ShieldCheck className="h-5 w-5" />}
          title="No open risks"
          description="Brain flags delivery and revenue risks here as your data shifts — nothing pressing right now."
        />
      )}

      {!isLoading && risks.length > 0 && (
        <div className="space-y-2">
          {risks.map((r) => (
            <Alert key={r.id} variant={SEVERITY_VARIANT[r.severity]} title={r.title}>
              <p className="text-sm">{r.why}</p>
              {r.recommended_action && (
                <p className="mt-1 text-sm font-medium">{r.recommended_action}</p>
              )}
            </Alert>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ── Courier performance table (shipment-outcomes.by_courier) ───────────────────

function CourierTable({ rows }: { rows: ShipmentHasData['by_courier'] }) {
  const [q, setQ] = useState('');
  const visible = rows.filter((r) => matchesQuery(q, r.courier));

  if (rows.length === 0) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        No courier breakdown in this window yet.
      </p>
    );
  }

  return (
    <>
      <div className="mb-3 flex justify-end">
        <TableSearch
          value={q}
          onChange={setQ}
          placeholder="Search courier…"
          className="w-full sm:w-56"
          aria-label="Search courier"
        />
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-1.5 font-medium">Courier</th>
            <th className="py-1.5 text-right font-medium">Delivered</th>
            <th className="py-1.5 text-right font-medium">RTO</th>
            <th className="py-1.5 text-right font-medium">RTO %</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => (
            <tr key={c.courier} className="border-b border-border/50 last:border-0">
              <td className="py-1.5 text-foreground">{c.courier}</td>
              <td className="py-1.5 text-right tabular-nums">{num(c.delivered)}</td>
              <td className="py-1.5 text-right tabular-nums">{num(c.rto)}</td>
              <td
                className="py-1.5 text-right font-medium tabular-nums"
                title={c.rto_pct === null ? 'Not enough data yet' : undefined}
              >
                {c.rto_pct === null ? '—' : `${c.rto_pct}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {q && visible.length === 0 && (
        <p className="py-3 text-center text-sm text-muted-foreground" role="status">
          No matches for &ldquo;{q}&rdquo;
        </p>
      )}
    </>
  );
}

// ── Shipment section (courier table + RTO-by-region chart) ──────────────────────

function ShipmentEmpty() {
  return (
    <EmptyState
      icon={<Truck className="h-8 w-8" />}
      title="No shipment data yet"
      description="Delivery vs RTO, courier performance and region leakage appear once a logistics connector (GoKwik or Shiprocket) starts sharing tracking updates."
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/settings/connectors">
            Connect a logistics source
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
      }
    />
  );
}

function ShipmentSection({ range }: { range: DateRange }) {
  const { data, isLoading, error, refetch } = useShipmentOutcomes({
    from: range.from,
    to: range.to,
  });
  // `data && data.state === '…'` (not `data?.state === '…'`) — optional chaining defeats
  // discriminated-union narrowing, leaving hasData as the full union.
  const hasData = data && data.state === 'has_data' ? data : null;
  const synthetic = hasData?.data_source === 'synthetic';

  // Map shipment by_pincode → the CodRtoCohort shape RtoPincodeChart consumes, sourced from
  // the SAME shipment-outcomes read (no separate endpoint). Terminal = delivered + RTO.
  const cohorts: CodRtoCohort[] = hasData
    ? hasData.by_pincode.map((p) => ({
        pincode: p.pincode,
        terminal_count: (BigInt(p.delivered) + BigInt(p.rto)).toString(),
        rto_count: p.rto,
        rto_rate_pct: p.rto_pct,
      }))
    : [];

  return (
    <section aria-label="Shipment outcomes" className="space-y-4">
      {hasData && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <KpiTile
            label="RTO rate"
            help="The share of finished shipments that came back undelivered (returned to origin) — lower is better."
            value={hasData.rto_pct === null ? null : `${hasData.rto_pct}%`}
            sublabel="returned ÷ shipments"
            lowerIsBetter
          />
          <KpiTile
            label="Delivered"
            help="Shipments that reached the customer."
            value={num(hasData.delivered)}
            sublabel="reached the customer"
          />
          <KpiTile
            label="RTO"
            help="Shipments that could not be delivered and came back to you."
            value={num(hasData.rto)}
            sublabel="returned to origin"
          />
          <KpiTile
            label="In transit"
            help="Shipments still on their way — not yet delivered or returned."
            value={num(hasData.in_transit)}
            sublabel="still on the way"
          />
          <KpiTile
            label="Total shipments"
            help="All shipments created in the selected period."
            value={num(hasData.total)}
            sublabel="in range"
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard
          title="Courier performance"
          description="Delivery vs RTO by courier — where return-to-origin concentrates."
          actions={
            synthetic ? (
              <SyntheticBadge reason="These shipment outcomes come from sample data used during setup — they are replaced once live courier tracking connects." />
            ) : undefined
          }
        >
          {isLoading && <Skeleton className="h-48 w-full" />}
          {!isLoading && error && <ErrorCard error={error} retry={refetch} />}
          {!isLoading && !error && data?.state === 'no_data' && <ShipmentEmpty />}
          {!isLoading && !error && hasData && <CourierTable rows={hasData.by_courier} />}
        </SectionCard>

        <SectionCard
          title={
            <span className="inline-flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              RTO by region
            </span>
          }
          description="Return-to-origin rate by destination pincode cohort."
        >
          {isLoading && <Skeleton className="h-64 w-full rounded-lg" />}
          {!isLoading && error && <ErrorCard error={error} retry={refetch} />}
          {!isLoading && !error && data?.state === 'no_data' && <ShipmentEmpty />}
          {!isLoading && !error && hasData && (
            <RtoPincodeChart cohorts={cohorts} pincodePending={false} />
          )}
        </SectionCard>
      </div>
    </section>
  );
}

// ── Return lifecycle (return-funnel) ───────────────────────────────────────────

function ReturnsEmpty() {
  return (
    <EmptyState
      icon={<RotateCcw className="h-8 w-8" />}
      title="No returns in this window"
      description="Return updates (initiated → in transit → delivered back to you → completed) appear here once a logistics source starts sending them. None recorded for this range — the honest state, not a made-up zero."
    />
  );
}

function ReturnsData({ data }: { data: ReturnHasData }) {
  const maxCount = data.by_class.reduce((m, b) => Math.max(m, Number(b.count)), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label="Total returns"
          help="How many return journeys started in the selected period."
          value={num(data.total)}
          sublabel={`${data.from} → ${data.to}`}
        />
        <KpiTile
          label="Completed"
          help="Returns that finished — the item came back and any refund was closed."
          value={num(data.completed)}
          sublabel="returned / refunded"
        />
        <KpiTile
          label="In progress"
          help="Returns that have started but have not finished yet."
          value={num(data.in_progress)}
          sublabel="not yet closed"
        />
        <KpiTile
          label="Completion rate"
          help="The share of returns that have fully finished."
          value={data.completion_pct === null ? null : `${data.completion_pct}%`}
          sublabel="completed ÷ total"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">Returns by stage</h3>
          {data.by_class.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No return stages in this window.</p>
          ) : (
            <ul className="space-y-2">
              {data.by_class.map((b) => {
                const pct = maxCount > 0 ? (Number(b.count) / maxCount) * 100 : 0;
                return (
                  <li key={b.return_class} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-foreground">
                        {RETURN_CLASS_LABEL[b.return_class] ?? b.return_class}
                      </span>
                      <span className="font-medium tabular-nums text-foreground">{num(b.count)}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/70"
                        style={{ width: `${Math.max(pct, 2)}%` }}
                        aria-hidden="true"
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">Returns by courier</h3>
          {data.by_courier.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No courier breakdown in this window.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1.5 font-medium">Courier</th>
                  <th className="py-1.5 text-right font-medium">Returns</th>
                  <th className="py-1.5 text-right font-medium">Completed</th>
                </tr>
              </thead>
              <tbody>
                {data.by_courier.map((c) => (
                  <tr key={c.courier} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 text-foreground">{c.courier}</td>
                    <td className="py-1.5 text-right tabular-nums">{num(c.total)}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums">{num(c.completed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function ReturnSection({ range }: { range: DateRange }) {
  const { data, isLoading, error, refetch } = useReturnFunnel({ from: range.from, to: range.to });
  const synthetic = data?.state === 'has_data' && data.data_source === 'synthetic';

  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          <RotateCcw className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Return lifecycle
        </span>
      }
      description="Returns are a separate lifecycle from forward delivery — a completed return is delivered back to origin / refund closed, never counted as a sale."
      actions={
        synthetic ? (
          <SyntheticBadge reason="These return figures come from sample data used during setup — they are replaced once live courier tracking connects." />
        ) : undefined
      }
    >
      {isLoading && <Skeleton className="h-48 w-full" />}
      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}
      {!isLoading && !error && data?.state === 'no_data' && <ReturnsEmpty />}
      {!isLoading && !error && data?.state === 'has_data' && <ReturnsData data={data} />}
    </SectionCard>
  );
}

// ── Delivery-time histogram (delivery-time — gold_delivery_time, P3) ────────────

function DeliveryEmpty() {
  return (
    <EmptyState
      icon={<Timer className="h-8 w-8" />}
      title="No delivery-time data yet"
      description="Per-courier delivery speed (dispatch → delivered, in whole days) appears once a logistics connector (GoKwik or Shiprocket) starts sharing delivery confirmations. None yet — the honest state, not a made-up zero."
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/settings/connectors">
            Connect a logistics source
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
      }
    />
  );
}

/**
 * One courier's delivery-time profile: avg days + total delivered + the fixed five-bucket
 * day histogram. Buckets are ALWAYS five (zero-count included) so the histogram never has
 * holes; ordered by bucket_order. Bars are horizontal (count = bar length), each carrying an
 * explicit "{bucket} days · count" label so the value reads WITHOUT colour.
 */
function CourierDeliveryCard({ courier }: { courier: DeliveryTimeCourier }) {
  const buckets = [...courier.buckets].sort((a, b) => a.bucket_order - b.bucket_order);
  const maxCount = buckets.reduce((m, b) => Math.max(m, Number(b.shipment_count)), 0);

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="truncate font-medium text-foreground">{courier.courier}</span>
        <span className="shrink-0 text-sm text-muted-foreground">
          <span
            className="font-medium tabular-nums text-foreground"
            title={courier.avg_delivery_days === null ? 'Not enough data yet' : undefined}
          >
            {courier.avg_delivery_days === null
              ? '—'
              : `${courier.avg_delivery_days.toFixed(1)} days`}
          </span>{' '}
          avg · {num(courier.courier_shipment_count)} delivered
        </span>
      </div>
      <ul className="space-y-2">
        {buckets.map((b) => {
          const count = Number(b.shipment_count);
          const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
          return (
            <li key={b.bucket} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{b.bucket} days</span>
                <span className="font-medium tabular-nums text-foreground">
                  {num(b.shipment_count)}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/70"
                  style={{ width: `${count > 0 ? Math.max(pct, 2) : 0}%` }}
                  aria-hidden="true"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DeliverySection() {
  const { data, isLoading, error, refetch } = useDeliveryTime();
  const hasData = data && data.state === 'has_data' ? data : null;

  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          <Timer className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Delivery time by courier
        </span>
      }
      description="Days from dispatch to delivered, per courier — how fast each courier really delivers, grouped into whole-day ranges."
    >
      {isLoading && <Skeleton className="h-48 w-full" />}
      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}
      {!isLoading && !error && data?.state === 'no_data' && <DeliveryEmpty />}
      {!isLoading && !error && hasData && hasData.by_courier.length === 0 && <DeliveryEmpty />}
      {!isLoading && !error && hasData && hasData.by_courier.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {hasData.by_courier.map((c) => (
            <CourierDeliveryCard key={c.courier} courier={c} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export function OperationsContent() {
  const [range, setRange] = useState<DateRange>(() => initialRange(OPERATIONS_RANGE_PRESETS, '90'));

  // Page-level freshness anchor — the briefing's gold-mart build time (shared medallion).
  const { data: briefingData } = useInsightsBriefing();
  const briefingAsOf =
    briefingData?.state === 'has_data' ? briefingData.briefing.as_of ?? undefined : undefined;

  return (
    <TabShell
      title="Operations"
      description="Where is revenue leaking in delivery?"
      explainer={OPERATIONS_EXPLAINER}
      freshness={<FreshnessBadge timestamp={briefingAsOf} prefix="Data as of" />}
      actions={
        <DateRangeFilter
          value={range}
          onChange={setRange}
          presets={OPERATIONS_RANGE_PRESETS}
          aria-label="Fulfillment date range"
        />
      }
    >
      <AlertsStrip />
      <ShipmentSection range={range} />
      <DeliverySection />
      <ReturnSection range={range} />
    </TabShell>
  );
}
