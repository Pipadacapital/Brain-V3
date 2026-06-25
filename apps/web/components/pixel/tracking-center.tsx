'use client';

/**
 * TrackingCenter — the Brain Pixel surface. Owns the page header (with a live, honest
 * status pill) and a single, trust-ordered vertical flow:
 *
 *   1. Live verification — the honest "waiting → first event received" flip leads,
 *      so a stakeholder sees the real signal first.
 *   2. Setup — install the pixel (connected-storefront-driven), verify it, copy the
 *      manual snippet.
 *   3. First-party host — optional CNAME ingest host.
 *   4. Tracking health — status + KPIs + volume.
 *   5. Event explorer — the recent-event feed.
 *
 * The header status pill is derived ONLY from real backend state (pixel_status +
 * tracking-health). It is never faked: no data ⇒ neutral, not a green "connected".
 */

import * as React from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { Separator } from '@/components/ui/separator';
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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-base font-semibold tracking-tight text-foreground">{children}</h2>
  );
}

export function TrackingCenter() {
  const status = useHeaderStatus();

  return (
    <div className="space-y-8" data-testid="tracking-center">
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

      {/* 1. Live verification leads — the honest first-event flip */}
      <LiveVerification />

      <Separator />

      {/* 2. Setup: install → verify → manual snippet */}
      <section aria-label="Setup and installation" className="space-y-4">
        <SectionHeading>Setup &amp; installation</SectionHeading>
        <PixelWizard />
        <FirstPartyHost />
      </section>

      <Separator />

      {/* 3. Tracking health */}
      <section aria-label="Tracking health" className="space-y-4">
        <SectionHeading>Tracking health</SectionHeading>
        <TrackingHealthPanel />
      </section>

      {/* 4. Event explorer */}
      <EventExplorer />
    </div>
  );
}
