'use client';

/**
 * TrackingCenter — the Brain Pixel surface. Owns the page header (with a live, honest
 * status pill) and a TABBED layout so the page fits without a long scroll:
 *
 *   - Overview — live verification (the honest "waiting → first event received" flip)
 *     + tracking health (status, KPIs, volume). The at-a-glance signal.
 *   - Install — install the pixel (connected-storefront-driven), verify it, copy the
 *     manual snippet, + the optional first-party CNAME ingest host.
 *   - Events — the recent-event feed (full captured context).
 *
 * The header status pill is derived ONLY from real backend state (pixel_status +
 * tracking-health). It is never faked: no data ⇒ neutral, not a green "connected".
 */

import * as React from 'react';
import { Activity, Download, ListTree } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { usePixelHealth } from '@/lib/hooks/use-pixel';
import { useTrackingHealth } from '@/lib/hooks/use-tracking-health';
import { LiveVerification } from './live-verification';
import { PixelWizard } from './pixel-wizard';
import { FirstPartyHost } from './first-party-host';
import { TrackingHealthPanel } from './tracking-health-panel';
import { EventExplorer } from './event-explorer';

/**
 * Derive ONE honest header status. Real Bronze data flowing wins; otherwise we fall
 * back to the pixel_status state. Unknown ⇒ neutral (never a fake success).
 */
function useHeaderStatus(): { tone: StatusTone; label: string; pulse: boolean } {
  const { data: pixelHealth } = usePixelHealth();
  const { data: tracking } = useTrackingHealth({ livePoll: false });

  if (tracking?.state === 'has_data') {
    return { tone: 'success', label: 'Receiving events', pulse: false };
  }
  switch (pixelHealth?.state) {
    case 'connected':
      return { tone: 'success', label: 'Connected', pulse: false };
    case 'syncing':
      return { tone: 'info', label: 'Waiting for first event', pulse: true };
    case 'waiting_for_data':
      return { tone: 'info', label: 'Installed — no data yet', pulse: true };
    case 'error':
      return { tone: 'destructive', label: 'Verification failed', pulse: false };
    default:
      return { tone: 'neutral', label: 'Not installed', pulse: false };
  }
}

export function TrackingCenter() {
  const status = useHeaderStatus();

  return (
    <div className="space-y-6" data-testid="tracking-center">
      {/* Heading kept as "Tracking Center" for the stable surface name. */}
      <PageHeader
        title="Tracking Center"
        description="Install the Brain Pixel, verify it’s live, and watch your first-party events arrive in real time."
        meta={
          <StatusBadge tone={status.tone} pulse={status.pulse}>
            {status.label}
          </StatusBadge>
        }
      />

      {/* Tabbed layout — each tab is one focused section, so the page no longer scrolls long. */}
      <Tabs defaultValue="overview">
        <TabsList aria-label="Tracking Center sections">
          <TabsTrigger value="overview">
            <Activity className="size-4" aria-hidden="true" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="install">
            <Download className="size-4" aria-hidden="true" />
            Install
          </TabsTrigger>
          <TabsTrigger value="events">
            <ListTree className="size-4" aria-hidden="true" />
            Events
          </TabsTrigger>
        </TabsList>

        {/* Overview — the at-a-glance signal: live verification + health. */}
        <TabsContent value="overview" className="space-y-6">
          <LiveVerification />
          <TrackingHealthPanel />
        </TabsContent>

        {/* Install — setup the pixel + the optional first-party host. */}
        <TabsContent value="install" className="space-y-6">
          <PixelWizard />
          <FirstPartyHost />
        </TabsContent>

        {/* Events — the recent-event feed with full captured context. */}
        <TabsContent value="events">
          <EventExplorer />
        </TabsContent>
      </Tabs>
    </div>
  );
}
