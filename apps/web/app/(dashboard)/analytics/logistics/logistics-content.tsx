'use client';

/**
 * LogisticsContent — the shipment-outcomes / courier-RTO surface (Silver tier, Slice 2).
 *
 * Reads ONLY via the BFF endpoint /api/v1/analytics/logistics/shipment-outcomes (the
 * metric-engine shipment-outcomes seam over silver_shipment, I-ST01) — never StarRocks/SQL
 * directly. Multi-source: GoKwik AWB today, Shiprocket once its connector merges.
 *
 * Shows the decision question — "where is revenue leaking to RTO, and which couriers/pincodes
 * drive it?": delivered/RTO/other/in-transit counts, overall RTO%, and RTO% by courier + pincode.
 * RTO% is an integer-basis-point string from the engine (never re-divided with floats here).
 *
 * Honest states: skeleton (aria-busy), ErrorCard with request_id, and an honest empty state
 * linking to the connector setup — never a fabricated zero. data_source drives the Synthetic badge.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Truck, ArrowRight, RotateCcw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { DateRangeFilter, type DateRange, initialRange } from '@/components/ui/date-range-filter';
import { TableSearch, matchesQuery } from '@/components/ui/table-search';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { useShipmentOutcomes, useReturnFunnel } from '@/lib/hooks/use-analytics';
import type {
  AnalyticsShipmentOutcomesResponse,
  AnalyticsReturnFunnelResponse,
} from '@/lib/api/types';

type ShipmentHasData = Extract<AnalyticsShipmentOutcomesResponse, { state: 'has_data' }>;
type ReturnHasData = Extract<AnalyticsReturnFunnelResponse, { state: 'has_data' }>;

/** return_class enum → human label (kept in sync with @brain/logistics-status classifyReturnStatus). */
const RETURN_CLASS_LABEL: Record<string, string> = {
  return_initiated: 'Initiated',
  return_in_transit: 'In transit',
  return_delivered: 'Delivered to origin',
  return_completed: 'Completed / refunded',
  none: 'Unclassified',
};

const LOGISTICS_RANGE_PRESETS = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '180', label: 'Last 180 days', days: 180 },
] as const;

function num(s: string): string {
  return Number(s).toLocaleString('en-IN');
}

function Loading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading shipment outcomes…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function EmptyCard() {
  return (
    <Card data-testid="logistics-empty">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <Truck className="h-8 w-8" />
        </div>
        <div>
          <p className="font-medium text-foreground">No shipment data yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            Shipment outcomes appear once a logistics connector (GoKwik or Shiprocket) starts
            sharing tracking updates. Delivered-vs-returned outcomes and courier performance are
            built from those updates.
          </p>
        </div>
        <Link href="/settings/connectors">
          <Button variant="outline" size="sm">
            Connect a logistics source
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

function RtoTable({
  title,
  keyLabel,
  rows,
  testid,
  searchPlaceholder,
}: {
  title: string;
  keyLabel: string;
  rows: { key: string; delivered: string; rto: string; rto_pct: string | null }[];
  testid: string;
  searchPlaceholder: string;
}) {
  const [q, setQ] = useState('');
  const visible = rows.filter((r) => matchesQuery(q, r.key));

  return (
    <Card data-testid={testid}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
          {rows.length > 0 && (
            <TableSearch
              value={q}
              onChange={setQ}
              placeholder={searchPlaceholder}
              className="w-full sm:w-48"
              aria-label={`Search ${keyLabel.toLowerCase()}`}
            />
          )}
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No {keyLabel.toLowerCase()} breakdown in this window yet.
          </p>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-1.5 font-medium">{keyLabel}</th>
                  <th className="py-1.5 font-medium text-right">Delivered</th>
                  <th className="py-1.5 font-medium text-right">RTO</th>
                  <th className="py-1.5 font-medium text-right">RTO %</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.key} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 text-foreground">{r.key}</td>
                    <td className="py-1.5 text-right tabular-nums">{num(r.delivered)}</td>
                    <td className="py-1.5 text-right tabular-nums">{num(r.rto)}</td>
                    <td
                      className="py-1.5 text-right tabular-nums font-medium"
                      title={r.rto_pct === null ? 'Not enough data yet' : undefined}
                    >
                      {r.rto_pct === null ? '—' : `${r.rto_pct}%`}
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
        )}
      </CardContent>
    </Card>
  );
}

export function LogisticsContent() {
  const [range, setRange] = useState<DateRange>(() =>
    initialRange(LOGISTICS_RANGE_PRESETS, '90'),
  );

  const q = useShipmentOutcomes({ from: range.from, to: range.to });
  const rq = useReturnFunnel({ from: range.from, to: range.to });
  const data = q.data;
  const returnData = rq.data;
  const synthetic =
    (data?.state === 'has_data' && data.data_source === 'synthetic') ||
    (returnData?.state === 'has_data' && returnData.data_source === 'synthetic');

  return (
    <div className="space-y-8">
      <PageHeader
        title="Logistics"
        description="Deliveries versus RTO (shipments returned to origin), and which couriers and pincodes drive them — counted from the tracking updates your logistics sources send (GoKwik, Shiprocket)."
        meta={
          <span
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Built from the delivery and return tracking updates your logistics connectors send."
          >
            <Truck className="h-3 w-3" aria-hidden="true" />
            Powered by shipment tracking
          </span>
        }
      />

      <section aria-label="Shipment outcomes">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">Shipment outcomes</h2>
            {synthetic && (
              <SyntheticBadge reason="Shipment data here comes from a sample source until your courier partner account is connected. It is never presented as live." />
            )}
          </div>
          <DateRangeFilter
            value={range}
            onChange={setRange}
            presets={LOGISTICS_RANGE_PRESETS}
            aria-label="Shipment outcomes date range"
          />
        </div>

        {q.isLoading && <Loading />}
        {!q.isLoading && q.error && <ErrorCard error={q.error} retry={q.refetch} />}
        {!q.isLoading && !q.error && data?.state === 'no_data' && <EmptyCard />}
        {!q.isLoading && !q.error && data?.state === 'has_data' && <OutcomesData data={data} />}
      </section>

      <section aria-label="Return lifecycle">
        <div className="mb-3 flex items-center gap-2">
          <RotateCcw className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-foreground">Return lifecycle</h2>
        </div>
        <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
          Returns are a <span className="font-medium text-foreground">separate</span> journey from
          forward delivery — a return that is &ldquo;delivered&rdquo; or &ldquo;completed&rdquo; means
          delivered <em>back</em> to you / refund closed, and is never counted as a sale. Built from
          the return-status updates Shiprocket sends.
        </p>

        {rq.isLoading && <Loading />}
        {!rq.isLoading && rq.error && <ErrorCard error={rq.error} retry={rq.refetch} />}
        {!rq.isLoading && !rq.error && returnData?.state === 'no_data' && <ReturnsEmptyCard />}
        {!rq.isLoading && !rq.error && returnData?.state === 'has_data' && (
          <ReturnsData data={returnData} />
        )}
      </section>
    </div>
  );
}

function ReturnsEmptyCard() {
  return (
    <Card data-testid="returns-empty">
      <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <RotateCcw className="h-7 w-7" />
        </div>
        <p className="font-medium text-foreground">No returns in this window</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Return updates (initiated → in transit → delivered back to you → completed) appear
          here once Shiprocket starts sending them. None were recorded for the selected range —
          that is the honest state, not a made-up zero.
        </p>
      </CardContent>
    </Card>
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
          value={data.completion_pct === null ? '—' : `${data.completion_pct}%`}
          sublabel={data.completion_pct === null ? 'Not enough data yet' : 'completed ÷ total'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card data-testid="returns-by-class">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Returns by stage
            </CardTitle>
          </CardHeader>
          <CardContent>
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
                        <span className="tabular-nums font-medium text-foreground">{num(b.count)}</span>
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
          </CardContent>
        </Card>

        <Card data-testid="returns-by-courier">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Returns by courier
            </CardTitle>
          </CardHeader>
          <CardContent>
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
                      <td className="py-1.5 text-right tabular-nums font-medium">{num(c.completed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function OutcomesData({ data }: { data: ShipmentHasData }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <KpiTile
          label="RTO rate"
          help="The share of finished shipments that came back undelivered (returned to origin)."
          value={data.rto_pct === null ? '—' : `${data.rto_pct}%`}
          sublabel={data.rto_pct === null ? 'Not enough data yet' : `${data.from} → ${data.to}`}
        />
        <KpiTile
          label="Delivered"
          help="Shipments that reached the customer."
          value={num(data.delivered)}
          sublabel="reached the customer"
        />
        <KpiTile
          label="RTO"
          help="Shipments that could not be delivered and came back to you."
          value={num(data.rto)}
          sublabel="returned to origin"
        />
        <KpiTile
          label="In transit"
          help="Shipments still on their way — not yet delivered or returned."
          value={num(data.in_transit)}
          sublabel="still on the way"
        />
        <KpiTile
          label="Total shipments"
          help="All shipments created in the selected period."
          value={num(data.total)}
          sublabel="in range"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RtoTable
          title="RTO by courier"
          keyLabel="Courier"
          testid="logistics-by-courier"
          searchPlaceholder="Search courier…"
          rows={data.by_courier.map((c) => ({ key: c.courier, delivered: c.delivered, rto: c.rto, rto_pct: c.rto_pct }))}
        />
        <RtoTable
          title="RTO by pincode"
          keyLabel="Pincode"
          testid="logistics-by-pincode"
          searchPlaceholder="Search pincode…"
          rows={data.by_pincode.map((p) => ({ key: p.pincode, delivered: p.delivered, rto: p.rto, rto_pct: p.rto_pct }))}
        />
      </div>
    </div>
  );
}
