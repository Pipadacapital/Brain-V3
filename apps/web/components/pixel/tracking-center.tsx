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
import { StatusPill, type StatusPillStatus } from '@/components/ui/status-pill';
import { Tooltip } from '@/components/ui/tooltip';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { usePixelHealth } from '@/lib/hooks/use-pixel';
import { useTrackingHealth } from '@/lib/hooks/use-tracking-health';
import { LiveVerification } from './live-verification';
import { PixelWizard } from './pixel-wizard';
import { FirstPartyHost } from './first-party-host';
import { TrackingHealthPanel } from './tracking-health-panel';
import { EventExplorer } from './event-explorer';

/** Green "Receiving events" only when a real event landed within the last 5 minutes. */
const RECEIVING_WINDOW_MS = 5 * 60 * 1000;

/**
 * Derive ONE honest header status. A real event within the last 5 minutes ⇒ green
 * "Receiving events"; otherwise the richer install states, always honest — an
 * installed-but-quiet pixel is "waiting", never a fake green.
 */
function useHeaderStatus(): { status: StatusPillStatus; label: string } {
  const { data: pixelHealth } = usePixelHealth();
  const { data: tracking } = useTrackingHealth({ livePoll: false });

  if (tracking?.state === 'has_data') {
    const lastTs = tracking.lastEventAt ? new Date(tracking.lastEventAt).getTime() : NaN;
    const receivingNow = !Number.isNaN(lastTs) && Date.now() - lastTs <= RECEIVING_WINDOW_MS;

    // Roll-up the honest client-side delivery signal: if the pixel dropped any events
    // client-side (pixel.dropped sum > 0), surface it as a warning rather than a flat
    // green — never hide real client-side loss behind "Receiving events".
    let clientDropped = 0n;
    try {
      clientDropped = BigInt(tracking.clientDroppedCount ?? '0');
    } catch {
      clientDropped = 0n;
    }
    if (clientDropped > 0n) {
      return { status: 'waiting', label: 'Receiving — some events lost in the browser' };
    }
    if (receivingNow) {
      return { status: 'healthy', label: 'Receiving events' };
    }
    return { status: 'waiting', label: 'Waiting for events' };
  }
  switch (pixelHealth?.state) {
    case 'connected':
      return { status: 'waiting', label: 'Connected — waiting for events' };
    case 'syncing':
      return { status: 'waiting', label: 'Waiting for your first event' };
    case 'waiting_for_data':
      return { status: 'waiting', label: 'Installed — no events yet' };
    case 'error':
      return { status: 'error', label: 'Verification failed' };
    default:
      return { status: 'waiting', label: 'Not installed yet' };
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
          <Tooltip content="Whether your storefront is sending data to Brain right now.">
            <StatusPill status={status.status} label={status.label} data-testid="tracking-center-status" />
          </Tooltip>
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
