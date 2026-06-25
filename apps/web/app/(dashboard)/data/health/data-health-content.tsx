'use client';

/**
 * DataHealthContent — client view for ingestion + connector-sync health.
 *
 * Surfaces (kpi-dashboard-design §data/integration health):
 *   - Event-volume-over-time (bronze ingestion) as a bar chart.
 *   - Data freshness: last ingest as relative time + an honest live-vs-stale verdict
 *     computed from lastIngestAt (NOT trusting the raw connector state alone).
 *   - Connector sync state badge + last-sync relative time.
 *   - Honest empty / loading / error states — never fabricates 0 or a confident
 *     "connected" over stale data.
 *
 * Mirrors the Phase-1 revenue page structure (header → KPI tiles → chart card → detail).
 */

import { Activity, Database, RefreshCw, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader as PageHeaderPrimitive } from '@/components/ui/page-header';
import { Alert } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { DataHealthVolumeChart } from '@/components/analytics/data-health-volume-chart';
import {
  FreshnessBadge,
  SyncStateBadge,
  freshnessFromIngest,
} from '@/components/analytics/data-health-sync-status';
import {
  formatRelativeTime,
  formatAbsoluteTime,
} from '@/components/analytics/data-health-relative-time';
import { useDataHealth } from '@/lib/hooks/use-analytics';

function PageHeader() {
  return (
    <PageHeaderPrimitive
      title="Data Health"
      description="Ingestion volume, freshness, and connector sync status."
    />
  );
}

export function DataHealthContent() {
  const { data, isLoading, error, refetch } = useDataHealth();

  // ── Error ────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <ErrorCard error={error} retry={() => refetch()} />
      </div>
    );
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile label="Last Ingest" value={null} isLoading />
          <KpiTile label="Connector" value={null} isLoading />
          <KpiTile label="Last Sync" value={null} isLoading />
        </div>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Ingestion Volume
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-64 w-full rounded-lg" />
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Empty (honest — no data at all) ────────────────────────────────────────
  if (!data || data.state === 'no_data') {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title="No data health signals yet"
              description="Once a connector is linked and events begin ingesting, freshness and volume will appear here."
              icon={<Database className="h-8 w-8" />}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Has data ───────────────────────────────────────────────────────────────
  const { eventVolume, lastIngestAt, syncState, lastSyncAt } = data;

  const freshness = freshnessFromIngest(lastIngestAt);
  const lastIngestRelative = formatRelativeTime(lastIngestAt);
  const lastSyncRelative = formatRelativeTime(lastSyncAt);

  return (
    <div className="space-y-6">
      <PageHeader />

      {/* Status tiles — freshness verdict + connector state (icon+label, never colour-only) */}
      <section aria-label="Data health status">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card className="p-5" role="region" aria-label={`Last ingest: ${lastIngestRelative}`}>
            <CardContent className="p-0 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                Last Ingest
              </p>
              <p
                className="text-2xl font-bold text-foreground leading-tight"
                title={formatAbsoluteTime(lastIngestAt)}
              >
                {lastIngestRelative}
              </p>
              <FreshnessBadge verdict={freshness.verdict} />
            </CardContent>
          </Card>

          <Card className="p-5" role="region" aria-label={`Connector state: ${syncState ?? 'no connector'}`}>
            <CardContent className="p-0 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Connector
              </p>
              <div className="pt-1">
                <SyncStateBadge state={syncState} />
              </div>
              <p className="text-xs text-muted-foreground">Connector sync state</p>
            </CardContent>
          </Card>

          <Card className="p-5" role="region" aria-label={`Last sync: ${lastSyncRelative}`}>
            <CardContent className="p-0 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                Last Sync
              </p>
              <p
                className="text-2xl font-bold text-foreground leading-tight"
                title={formatAbsoluteTime(lastSyncAt)}
              >
                {lastSyncRelative}
              </p>
              <p className="text-xs text-muted-foreground">Connector handshake</p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Honest stale callout — only when ingestion is lagging/stale */}
      {(freshness.verdict === 'lagging' || freshness.verdict === 'stale') && (
        <Alert variant="warning" icon={<Clock className="size-4" />}>
          {freshness.verdict === 'stale'
            ? `Ingestion is stale — the last event arrived ${lastIngestRelative}. Numbers across analytics may be out of date even if the connector reads "${syncState ?? 'connected'}".`
            : `Ingestion is lagging — the last event arrived ${lastIngestRelative}. Recent figures may be incomplete.`}
        </Alert>
      )}

      {/* Event volume over time */}
      <section aria-label="Event ingestion volume">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Activity className="h-4 w-4" aria-hidden="true" />
              Ingestion Volume
              <span className="text-xs font-normal text-muted-foreground/70">
                — bronze events, last 30 days
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DataHealthVolumeChart data={eventVolume} isLoading={false} className="h-64" />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
