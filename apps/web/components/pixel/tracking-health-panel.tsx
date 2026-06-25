'use client';

/**
 * TrackingHealthPanel — the Tracking Health surface:
 *   - honest status (healthy / waiting / stale) via StatusBadge — never colour-only
 *   - KPIs (events, last-event freshness, consent, quarantine) via MetricCard
 *   - events-flowing volume chart (reuses DataHealthVolumeChart)
 *
 * HONESTY: every number comes straight from the tracking-health BFF read. Quarantine
 * volume has no per-brand DB sink (events route to a Kafka `.quarantine` topic, not a
 * table), so it is shown as an explicit "—" with a note — never a fabricated 0.
 */

import * as React from 'react';
import { Activity } from 'lucide-react';
import { SectionCard } from '@/components/ui/section-card';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { MetricCard } from '@/components/ui/metric-card';
import { FreshnessIndicator } from '@/components/ui/freshness-indicator';
import { ErrorCard } from '@/components/ui/error-card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataHealthVolumeChart } from '@/components/analytics/data-health-volume-chart';
import {
  formatRelativeTime,
  formatAbsoluteTime,
} from '@/components/analytics/data-health-relative-time';
import { useTrackingHealth } from '@/lib/hooks/use-tracking-health';
import { deriveTrackingStatus, type TrackingStatus, STALE_THRESHOLD_MS } from './tracking-status';

const STATUS_CONFIG: Record<TrackingStatus, { tone: StatusTone; label: string; description: string; pulse?: boolean }> = {
  healthy: { tone: 'success', label: 'Healthy', description: 'Events are flowing into Brain.' },
  waiting: {
    tone: 'neutral',
    label: 'No events yet',
    description: 'No event has reached Brain for this brand yet.',
  },
  stale: {
    tone: 'warning',
    label: 'Stale',
    description: 'Events were flowing but have gone quiet (no event in 24h+).',
  },
};

function formatCount(n: string | undefined): string {
  if (n == null) return '0';
  try {
    return Number(BigInt(n)).toLocaleString();
  } catch {
    return '0';
  }
}

export function TrackingHealthPanel() {
  const { data: health, isLoading, error, refetch } = useTrackingHealth({ livePoll: false });

  if (isLoading) {
    return (
      <div className="space-y-6" data-testid="tracking-health-loading">
        <Skeleton className="h-24 w-full rounded-lg" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (error) {
    return <ErrorCard error={error} retry={refetch} />;
  }

  const status = deriveTrackingStatus(health);
  const cfg = STATUS_CONFIG[status];

  const hasData = health?.state === 'has_data';
  const lastEventAt = hasData ? health.lastEventAt : null;
  const totalEvents = hasData ? health.totalEvents : '0';
  const consentGranted = hasData ? health.consentGrantedCount : '0';
  const consentTotal = hasData ? health.consentTotalCount : '0';
  const volume = hasData ? health.eventVolume : [];

  const lastTs = lastEventAt ? new Date(lastEventAt).getTime() : NaN;
  const lastStale = !Number.isNaN(lastTs) && Date.now() - lastTs > STALE_THRESHOLD_MS;

  return (
    <div className="space-y-6" data-testid="tracking-health-panel">
      {/* Honest status — StatusBadge pairs a dot with a text label */}
      <SectionCard
        title="Tracking status"
        meta={
          <StatusBadge tone={cfg.tone} pulse={cfg.pulse} data-status={status} data-testid="tracking-health-status">
            {cfg.label}
          </StatusBadge>
        }
      >
        <p className="text-sm text-muted-foreground">{cfg.description}</p>
      </SectionCard>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div data-testid="kpi-total-events">
          <MetricCard
            label="Events (30d)"
            value={hasData ? formatCount(totalEvents) : undefined}
            unit="collected"
          />
        </div>
        <div data-testid="kpi-last-event">
          <MetricCard
            label="Last event"
            value={lastEventAt ? formatRelativeTime(lastEventAt) : undefined}
            freshness={
              lastEventAt ? (
                <FreshnessIndicator
                  label={formatAbsoluteTime(lastEventAt)}
                  tone={lastStale ? 'stale' : 'fresh'}
                />
              ) : undefined
            }
          />
        </div>
        <div data-testid="kpi-consent">
          <MetricCard
            label="Analytics consent"
            value={hasData ? `${formatCount(consentGranted)} / ${formatCount(consentTotal)}` : undefined}
            unit="events"
          />
        </div>
        <div data-testid="kpi-quarantine">
          <MetricCard
            label="Quarantined"
            value="—"
            unit="not stored per-brand"
          />
        </div>
      </div>

      {/* Events-flowing volume chart (reused, keeps its SR table fallback) */}
      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" aria-hidden="true" />
            Events flowing
          </span>
        }
        description="Daily collected-event volume, last 30 days."
        data-testid="tracking-health-volume"
      >
        <DataHealthVolumeChart data={volume} isLoading={false} />
      </SectionCard>
    </div>
  );
}
