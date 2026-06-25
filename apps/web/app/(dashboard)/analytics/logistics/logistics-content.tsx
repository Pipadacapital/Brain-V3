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
import { Truck, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { DateRangeFilter, type DateRange, initialRange } from '@/components/ui/date-range-filter';
import { TableSearch, matchesQuery } from '@/components/ui/table-search';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { useShipmentOutcomes } from '@/lib/hooks/use-analytics';
import type { AnalyticsShipmentOutcomesResponse } from '@/lib/api/types';

type ShipmentHasData = Extract<AnalyticsShipmentOutcomesResponse, { state: 'has_data' }>;

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
            Shipment outcomes appear once a logistics connector (GoKwik or Shiprocket) syncs
            AWB / tracking lifecycle events. Delivery vs RTO and courier performance build from
            those in the Silver tier.
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
                    <td className="py-1.5 text-right tabular-nums font-medium">
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
  const data = q.data;
  const synthetic = data?.state === 'has_data' && data.data_source === 'synthetic';

  return (
    <div className="space-y-8">
      <PageHeader
        title="Logistics"
        description="Delivery vs RTO outcomes and courier / pincode performance — folded deterministically from shipment-lifecycle events across every logistics source (GoKwik AWB, Shiprocket)."
        meta={
          <span
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Read from the Silver tier (silver_shipment) via the metric-engine shipment-outcomes seam."
          >
            <Truck className="h-3 w-3" aria-hidden="true" />
            Powered by the Silver tier
          </span>
        }
      />

      <section aria-label="Shipment outcomes">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">Shipment outcomes</h2>
            {synthetic && (
              <SyntheticBadge reason="Shipment lifecycle is fixture-sourced in dev (real shape, synthetic source) until partner sandbox access. Never presented as live." />
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
    </div>
  );
}

function OutcomesData({ data }: { data: ShipmentHasData }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <KpiTile label="RTO rate" value={data.rto_pct === null ? '—' : `${data.rto_pct}%`} sublabel={`${data.from} → ${data.to}`} />
        <KpiTile label="Delivered" value={num(data.delivered)} sublabel="terminal" />
        <KpiTile label="RTO" value={num(data.rto)} sublabel="returned to origin" />
        <KpiTile label="In transit" value={num(data.in_transit)} sublabel="not yet terminal" />
        <KpiTile label="Total shipments" value={num(data.total)} sublabel="in range" />
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
