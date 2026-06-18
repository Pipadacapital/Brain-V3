'use client';

/**
 * TrackingHealthPanel — the Tracking Health surface (Phase 1b):
 *   - honest status badge (healthy / waiting / stale) — icon + text, never colour-only
 *   - events-flowing volume chart (reuses DataHealthVolumeChart)
 *   - last-event freshness (reuses formatRelativeTime/formatAbsoluteTime)
 *   - total-events + consent-capture KpiTiles
 *
 * HONESTY: every number comes straight from the tracking-health BFF read. Quarantine
 * volume has no per-brand DB sink in Phase 1 (events are routed to a Kafka
 * `.quarantine` topic, not a table), so it is shown as an explicit "—" with a note —
 * never a fabricated 0.
 *
 * A11y: status badge carries role="status" + icon + label + aria-label; the chart
 * keeps its SR <table> fallback; KpiTiles carry their own region labels.
 */

import * as React from 'react';
import { CheckCircle2, Clock, AlertTriangle, Activity } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { Skeleton } from '@/components/ui/skeleton';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { DataHealthVolumeChart } from '@/components/analytics/data-health-volume-chart';
import {
  formatRelativeTime,
  formatAbsoluteTime,
} from '@/components/analytics/data-health-relative-time';
import { useTrackingHealth } from '@/lib/hooks/use-tracking-health';
import { deriveTrackingStatus, type TrackingStatus } from './tracking-status';
import { cn } from '@/lib/utils';

const STATUS_CONFIG: Record<
  TrackingStatus,
  { icon: React.ElementType; label: string; description: string; textClass: string; bgClass: string }
> = {
  healthy: {
    icon: CheckCircle2,
    label: 'Healthy',
    description: 'Events are flowing into Brain.',
    textClass: 'text-status-green-700',
    bgClass: 'bg-status-green-50',
  },
  waiting: {
    icon: Clock,
    label: 'No events yet',
    description: 'No event has reached Brain for this brand yet.',
    textClass: 'text-muted-foreground',
    bgClass: 'bg-muted/50',
  },
  stale: {
    icon: AlertTriangle,
    label: 'Stale',
    description: 'Events were flowing but have gone quiet (no event in 24h+).',
    textClass: 'text-status-amber-700',
    bgClass: 'bg-status-amber-50',
  },
};

function formatCount(n: string | undefined): string {
  if (n == null) return '0';
  try {
    return Number(BigInt(n)).toLocaleString('en-IN');
  } catch {
    return '0';
  }
}

export function TrackingHealthPanel() {
  const { data: health, isLoading, error, refetch } = useTrackingHealth({ livePoll: false });

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="tracking-health-loading">
        <Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return <ErrorCard error={error} retry={refetch} />;
  }

  const status = deriveTrackingStatus(health);
  const cfg = STATUS_CONFIG[status];
  const StatusIcon = cfg.icon;

  const hasData = health?.state === 'has_data';
  const lastEventAt = hasData ? health.lastEventAt : null;
  const totalEvents = hasData ? health.totalEvents : '0';
  const consentGranted = hasData ? health.consentGrantedCount : '0';
  const consentTotal = hasData ? health.consentTotalCount : '0';
  const volume = hasData ? health.eventVolume : [];

  return (
    <div className="space-y-6" data-testid="tracking-health-panel">
      {/* Honest status — icon + label, never colour-only */}
      <Card data-testid="tracking-health-status">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Tracking status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <span
            role="status"
            aria-label={`Tracking status: ${cfg.label}. ${cfg.description}`}
            data-status={status}
            className={cn(
              'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium',
              cfg.bgClass,
              cfg.textClass,
            )}
          >
            <StatusIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {cfg.label}
          </span>
          <p className="mt-2 text-sm text-muted-foreground">{cfg.description}</p>
        </CardContent>
      </Card>

      {/* KPI row: total events, last-event freshness, consent capture, quarantine note */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Events (30d)"
          value={hasData ? formatCount(totalEvents) : null}
          sublabel="Collected in the last 30 days"
          data-testid="kpi-total-events"
        />
        <KpiTile
          label="Last event"
          value={lastEventAt ? formatRelativeTime(lastEventAt) : null}
          sublabel={lastEventAt ? formatAbsoluteTime(lastEventAt) : 'No events yet'}
          data-testid="kpi-last-event"
        />
        <KpiTile
          label="Analytics consent"
          value={hasData ? `${formatCount(consentGranted)} / ${formatCount(consentTotal)}` : null}
          sublabel="Events with analytics consent (capture only)"
          data-testid="kpi-consent"
        />
        <KpiTile
          label="Quarantined"
          value="—"
          sublabel="Routed to the quarantine topic; not stored per-brand in Phase 1"
          data-testid="kpi-quarantine"
        />
      </div>

      {/* Events-flowing volume chart (reused, with its SR table fallback) */}
      <Card data-testid="tracking-health-volume">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Events flowing
          </CardTitle>
          <CardDescription>Daily collected-event volume, last 30 days.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataHealthVolumeChart data={volume} isLoading={false} />
        </CardContent>
      </Card>
    </div>
  );
}
