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
 * Honesty rules (Brain): counts are bigint-as-string → Number(...).toLocaleString (NOT money,
 * never /100); every panel renders an honest EmptyState / em-dash, never a fabricated zero;
 * SyntheticBadge shows whenever the source reports data_source='synthetic'. A delivery-time
 * histogram has NO mart today → omitted entirely rather than fabricated.
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
} from '@/lib/hooks/use-analytics';
import type {
  AnalyticsShipmentOutcomesResponse,
  AnalyticsReturnFunnelResponse,
  CodRtoCohort,
  InsightDto,
  InsightSeverity,
} from '@/lib/api/types';

type ShipmentHasData = Extract<AnalyticsShipmentOutcomesResponse, { state: 'has_data' }>;
type ReturnHasData = Extract<AnalyticsReturnFunnelResponse, { state: 'has_data' }>;

const OPERATIONS_EXPLAINER: ExplainerPanelProps = {
  title: 'Operations — Where is revenue leaking in delivery?',
  description:
    'The fulfillment surface: which couriers and regions drive return-to-origin (RTO), how returns move through their own lifecycle, and the open delivery risks worth acting on. Folded deterministically from shipment-lifecycle events (GoKwik AWB, Shiprocket) in the Silver tier.',
  sections: [
    {
      heading: 'How to read this page',
      body:
        'RTO is revenue that shipped but came back — pure leakage. The courier and region tables rank where it concentrates so you can renegotiate or restrict COD. Returns are a SEPARATE lifecycle: a "completed" return is delivered BACK to origin, never a sale. Counts are exact; anything without data shows an honest empty state, never a fabricated zero.',
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
            <SyntheticBadge reason="Computed from synthetic demo data seeded into the Gold marts — never live data. It disappears once real data flows." />
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
              <td className="py-1.5 text-right font-medium tabular-nums">
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
      description="Delivery vs RTO, courier performance and region leakage appear once a logistics connector (GoKwik or Shiprocket) syncs AWB / tracking lifecycle events into the Silver tier."
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
            value={hasData.rto_pct === null ? null : `${hasData.rto_pct}%`}
            sublabel="returned ÷ shipments"
            lowerIsBetter
          />
          <KpiTile label="Delivered" value={num(hasData.delivered)} sublabel="terminal" />
          <KpiTile label="RTO" value={num(hasData.rto)} sublabel="returned to origin" />
          <KpiTile label="In transit" value={num(hasData.in_transit)} sublabel="not yet terminal" />
          <KpiTile label="Total shipments" value={num(hasData.total)} sublabel="in range" />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard
          title="Courier performance"
          description="Delivery vs RTO by courier — where return-to-origin concentrates."
          actions={
            synthetic ? (
              <SyntheticBadge reason="Shipment lifecycle is fixture-sourced in dev (real shape, synthetic source) until partner sandbox access. Never presented as live." />
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
      description="Return-lifecycle events (initiated → in transit → delivered to origin → completed) appear here once a logistics source sends return webhooks. None recorded for this range — the honest state, not a fabricated zero."
    />
  );
}

function ReturnsData({ data }: { data: ReturnHasData }) {
  const maxCount = data.by_class.reduce((m, b) => Math.max(m, Number(b.count)), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile label="Total returns" value={num(data.total)} sublabel={`${data.from} → ${data.to}`} />
        <KpiTile label="Completed" value={num(data.completed)} sublabel="returned / refunded" />
        <KpiTile label="In progress" value={num(data.in_progress)} sublabel="not yet closed" />
        <KpiTile
          label="Completion rate"
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
          <SyntheticBadge reason="Return lifecycle is fixture-sourced in dev (real shape, synthetic source) until partner sandbox access. Never presented as live." />
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
      <ReturnSection range={range} />
    </TabShell>
  );
}
