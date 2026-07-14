'use client';

/**
 * TrackingHealthPanel — the Tracking Health surface:
 *   - honest status (healthy / waiting / stale) via StatusPill — never colour-only
 *   - KPIs (events, last-event freshness, consent, quarantine) via MetricCard, every
 *     title carrying a plain-language "?" tooltip (MetricTitle)
 *   - events-flowing volume chart (reuses DataHealthVolumeChart)
 *
 * HONESTY: every number comes straight from the tracking-health BFF read. Quarantine
 * volume has no per-brand DB sink (events route to a Kafka `.quarantine` topic, not a
 * table), so it is shown as an explicit "—" with a tooltip — never a fabricated 0.
 */

import * as React from 'react';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusPillStatus } from '@/components/ui/status-pill';
import { MetricCard } from '@/components/ui/metric-card';
import { MetricTitle } from '@/components/ui/metric-title';
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

const STATUS_CONFIG: Record<
  TrackingStatus,
  { status: StatusPillStatus; label: string; description: string }
> = {
  healthy: {
    status: 'healthy',
    label: 'Receiving events',
    description: 'Your storefront is sending events to Brain.',
  },
  waiting: {
    status: 'waiting',
    label: 'Waiting for events',
    description: 'No event has reached Brain for this brand yet.',
  },
  stale: {
    status: 'waiting',
    label: 'Gone quiet',
    description: 'Events were arriving, but none in the last 24 hours.',
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

  // Client-side delivery reliability — the pixel.dropped sum (events the browser pixel
  // had to evict under queue overflow). This is the ONE honest client-loss signal the
  // BFF provides. 0 ⇒ everything reached Brain; >0 ⇒ N events were dropped client-side.
  const clientDroppedRaw = hasData ? health.clientDroppedCount : '0';
  let clientDropped = 0n;
  try {
    clientDropped = BigInt(clientDroppedRaw ?? '0');
  } catch {
    clientDropped = 0n;
  }
  const hasClientLoss = clientDropped > 0n;

  const lastTs = lastEventAt ? new Date(lastEventAt).getTime() : NaN;
  const lastStale = !Number.isNaN(lastTs) && Date.now() - lastTs > STALE_THRESHOLD_MS;

  return (
    <div className="space-y-6" data-testid="tracking-health-panel">
      {/* Honest status — StatusPill pairs a shaped glyph with a text label */}
      <SectionCard
        title={
          <MetricTitle
            label="Tracking status"
            help="Whether your storefront is sending data to Brain right now."
          />
        }
        meta={
          <StatusPill
            status={cfg.status}
            label={cfg.label}
            data-status={status}
            data-testid="tracking-health-status"
          />
        }
      >
        <p className="text-sm text-muted-foreground">{cfg.description}</p>
      </SectionCard>

      {/* KPIs — every title carries a plain-language "?" tooltip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div data-testid="kpi-total-events">
          <MetricCard
            label={
              <MetricTitle
                label="Events collected (last 30 days)"
                help="How many events your storefront sent to Brain in the last 30 days."
              />
            }
            value={hasData ? formatCount(totalEvents) : undefined}
          />
        </div>
        <div data-testid="kpi-last-event">
          <MetricCard
            label={
              <MetricTitle
                label="Last event"
                help="When the most recent event arrived from your storefront."
              />
            }
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
            label={
              <MetricTitle
                label="Analytics consent"
                help="How many events came from visitors who agreed to analytics tracking."
              />
            }
            value={hasData ? `${formatCount(consentGranted)} / ${formatCount(consentTotal)}` : undefined}
            unit="events"
          />
        </div>
        <div data-testid="kpi-quarantine">
          <MetricCard
            label={
              <MetricTitle
                label="Quarantined"
                help="Events that fail validation are set aside in a shared holding stream for replay, so Brain has no per-brand count to show here."
              />
            }
            value="—"
            unit="no per-brand count"
          />
        </div>
      </div>

      {/* Events-flowing volume chart (reused, keeps its SR table fallback) */}
      <SectionCard
        title={
          <MetricTitle
            label="Daily events"
            help="How many events arrived from your storefront each day over the last 30 days."
          />
        }
        description="Events per day, last 30 days."
        data-testid="tracking-health-volume"
      >
        <DataHealthVolumeChart data={volume} isLoading={false} />
      </SectionCard>

      {/* Delivery reliability — honest CLIENT-SIDE drop signal (pixel.dropped sum). Shows
          "All events delivered" at 0, or "N events were lost in visitors' browsers" when >0.
          Never a fabricated 0 chart — it's a single honest tile. */}
      <SectionCard
        title={
          <MetricTitle
            label="Delivery reliability"
            help="Whether every event sent from your visitors' browsers actually reached Brain."
          />
        }
        meta={
          <StatusPill
            status={hasClientLoss ? 'waiting' : 'healthy'}
            label={hasClientLoss ? 'Some events lost' : 'Reliable'}
            data-testid="tracking-health-delivery-status"
          />
        }
        data-testid="tracking-health-delivery"
      >
        <div data-testid="kpi-client-dropped">
          <MetricCard
            label={
              <MetricTitle
                label="Browser delivery"
                help="Counts events a visitor's browser could not send to Brain, usually because the page closed too quickly."
              />
            }
            value={
              hasData
                ? hasClientLoss
                  ? `${clientDropped.toLocaleString()} events were lost in visitors' browsers before reaching Brain`
                  : 'All events delivered'
                : undefined
            }
            unit={hasClientLoss ? undefined : 'no events lost'}
          />
        </div>
      </SectionCard>
    </div>
  );
}
