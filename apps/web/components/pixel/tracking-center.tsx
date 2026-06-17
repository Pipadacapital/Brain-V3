'use client';

/**
 * TrackingCenter — the stakeholder-visible proof surface that the Brain Pixel works
 * (Phase 1 Track C). Composes the four sections in decision-priority order:
 *
 *   1. Live Verification — "waiting for your first event…" → "✅ first event received"
 *      (the honest flip, driven only by a real Bronze event landing).
 *   2. Setup / Installation — the existing PixelWizard (install_token + snippet +
 *      "I've installed it" + verify). Reused unchanged (extend, don't fork).
 *   3. Tracking Health — status + volume + freshness + consent capture.
 *   4. Event Explorer — recent collected events (type/time/anonymized ids).
 *
 * Verification leads so a stakeholder sees the live signal first; setup is right below
 * for the install step. Health + Explorer give ongoing proof once data flows.
 */

import * as React from 'react';
import { LiveVerification } from './live-verification';
import { PixelWizard } from './pixel-wizard';
import { TrackingHealthPanel } from './tracking-health-panel';
import { EventExplorer } from './event-explorer';

export function TrackingCenter() {
  return (
    <div className="space-y-10" data-testid="tracking-center">
      {/* 1. Live verification — the honest first-event flip leads the surface */}
      <section aria-labelledby="tc-verify-heading">
        <h2 id="tc-verify-heading" className="sr-only">
          Live verification
        </h2>
        <LiveVerification />
      </section>

      {/* 2. Setup / installation wizard (install_token + snippet + verify) */}
      <section aria-labelledby="tc-setup-heading">
        <h2 id="tc-setup-heading" className="text-lg font-semibold text-foreground mb-3">
          Setup &amp; installation
        </h2>
        <PixelWizard />
      </section>

      {/* 3. Tracking health */}
      <section aria-labelledby="tc-health-heading">
        <h2 id="tc-health-heading" className="text-lg font-semibold text-foreground mb-3">
          Tracking health
        </h2>
        <TrackingHealthPanel />
      </section>

      {/* 4. Event explorer */}
      <section aria-labelledby="tc-explorer-heading">
        <h2 id="tc-explorer-heading" className="text-lg font-semibold text-foreground mb-3">
          Event explorer
        </h2>
        <EventExplorer />
      </section>
    </div>
  );
}
