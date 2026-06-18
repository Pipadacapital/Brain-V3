'use client';

/**
 * JourneyContent — the journey / first-touch surface (Silver tier, Phase 4).
 *
 * The SECOND surface read from the Silver analytics tier (dbt → StarRocks
 * silver.touchpoint), proving Silver → metric-engine journey seam → BFF → UI
 * end-to-end for the journey layer. It reads ONLY via the BFF endpoints
 * /api/v1/analytics/journey/* (the metric-engine journey seam, I-ST01) — NEVER
 * StarRocks/SQL directly, never an inlined COUNT in the client.
 *
 * What it shows (the decision question — "where do my conversions FIRST come from,
 * and how much of the anonymous traffic do we link to known orders?"):
 *   - First-touch channel mix (count + share by channel) — Recharts horizontal bars.
 *   - Cart-stitch hit-rate KPI (deterministic anon→order linkage).
 *   - A coverage KPI (distinct journeys in range) + an honest real-vs-synthetic line.
 *   - A per-order touchpoint timeline (trace one order's journey).
 *
 * Count/share math is integer-only (BigInt counts; share_pct/hit_pct are 2dp strings
 * from the engine — never re-divided with floats in the client). There is NO money
 * column on a touchpoint, so NO money is rendered on this surface.
 *
 * DEV-HONESTY: data_source comes from the BFF (never hardcoded). The 94 real
 * page.viewed events are thin, so a window may be enriched with CLEARLY-LABELLED
 * synthetic journey fixtures; when that happens the BFF returns data_source='synthetic'
 * and the <SyntheticBadge/> renders + the real-vs-synthetic coverage line is explicit.
 * When real coverage is sufficient the BFF returns 'live' and the badge disappears with
 * no UI change. A subtle "Powered by the Silver tier" label marks the provenance.
 *
 * Honest states: skeleton (aria-busy), ErrorCard with request_id on error, and an honest
 * empty state linking /settings/pixel — never a fabricated zero.
 *
 * A11y: each section is a labelled region; the chart carries an SR-table fallback +
 * role=img; status/synthetic/coverage indicators are icon+label (never colour-only);
 * the timeline is an ordered list with reading order matching visual order.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Layers, ArrowRight, Footprints } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { FirstTouchMixChart } from '@/components/analytics/first-touch-mix-chart';
import { StitchRateCard } from '@/components/analytics/stitch-rate-card';
import { TouchpointTimeline } from '@/components/analytics/touchpoint-timeline';
import {
  useJourneyFirstTouchMix,
  useJourneyStitchRate,
} from '@/lib/hooks/use-analytics';
import type {
  AnalyticsJourneyFirstTouchMixResponse,
  AnalyticsJourneyStitchRateResponse,
} from '@/lib/api/types';

type FirstTouchHasData = Extract<AnalyticsJourneyFirstTouchMixResponse, { state: 'has_data' }>;
type StitchHasData = Extract<AnalyticsJourneyStitchRateResponse, { state: 'has_data' }>;

/** Date-range presets (days). The range drives the BFF query + local UI state. */
const RANGE_PRESETS = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '180', label: 'Last 180 days', days: 180 },
] as const;
type RangeKey = (typeof RANGE_PRESETS)[number]['key'];

function rangeFor(days: number): { from: string; to: string } {
  const to = new Date().toISOString().split('T')[0] as string;
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0] as string;
  return { from, to };
}

function MixSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading journey mix…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

/** Honest empty card with a pixel-setup CTA (never a fabricated zero). */
function EmptyPixelCard() {
  return (
    <Card data-testid="journey-empty">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <Footprints className="h-8 w-8" />
        </div>
        <div>
          <p className="font-medium text-foreground">No journeys yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            Journeys appear once the Brain Pixel captures page views with UTM / click-id
            context. First-touch mix and the cart-stitch hit-rate build from those
            touchpoints in the Silver tier.
          </p>
        </div>
        <Link href="/settings/pixel">
          <Button variant="outline" size="sm">
            Set up the Brain Pixel
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

export function JourneyContent() {
  const [rangeKey, setRangeKey] = useState<RangeKey>('90');
  const preset = RANGE_PRESETS.find((p) => p.key === rangeKey) ?? RANGE_PRESETS[1];
  const { from, to } = rangeFor(preset.days);

  const mixQ = useJourneyFirstTouchMix({ from, to });
  const stitchQ = useJourneyStitchRate({ from, to });

  const isLoading = mixQ.isLoading;
  const error = mixQ.error;

  const mix = mixQ.data;
  const stitch = stitchQ.data;

  const synthetic =
    (mix?.state === 'has_data' && mix.data_source === 'synthetic') ||
    (stitch?.state === 'has_data' && stitch.data_source === 'synthetic');

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-foreground">Journey</h1>
          {/* Subtle provenance: this surface is powered by the Silver tier. */}
          <span
            data-testid="journey-silver-label"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Read from the Silver analytics tier (dbt → StarRocks silver.touchpoint) via the metric-engine journey seam."
          >
            <Layers className="h-3 w-3" aria-hidden="true" />
            Powered by the Silver tier
          </span>
        </div>
        <p className="text-muted-foreground mt-1">
          First-touch channel mix, the deterministic cart-stitch hit-rate, and a
          per-order touchpoint timeline — sessionized from SDK page views, deterministically
          linked to known orders (never inferred).
        </p>
      </div>

      {/* ── First-touch mix + coverage + stitch-rate ── */}
      <section aria-label="First-touch channel mix" data-testid="journey-mix-section">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">First-touch mix</h2>
            {synthetic && (
              <SyntheticBadge
                data-testid="journey-synthetic-badge"
                reason="The 94 real page.viewed SDK events are thin, so this window is enriched with clearly-labelled synthetic journey fixtures (real shape, synthetic source) for a richer demo. Real-vs-synthetic coverage is shown below. Never presented as live."
              />
            )}
          </div>

          {/* Date-range selector — drives the BFF query (local UI state). */}
          <div
            role="group"
            aria-label="Date range"
            className="inline-flex rounded-md border border-border p-0.5"
          >
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setRangeKey(p.key)}
                aria-pressed={rangeKey === p.key}
                data-testid={`journey-range-${p.key}`}
                className={
                  rangeKey === p.key
                    ? 'rounded px-3 py-1 text-xs font-medium bg-foreground text-background'
                    : 'rounded px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground'
                }
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {isLoading && <MixSkeleton />}
        {!isLoading && error && <ErrorCard error={error} retry={mixQ.refetch} />}

        {!isLoading && !error && mix?.state === 'no_data' && <EmptyPixelCard />}

        {!isLoading && !error && mix?.state === 'has_data' && (
          <JourneyMixData mix={mix} stitch={stitch?.state === 'has_data' ? stitch : null} />
        )}
      </section>

      {/* ── Touchpoint timeline (trace one order) ── */}
      <section aria-label="Touchpoint timeline" data-testid="journey-timeline-wrapper">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-foreground">Touchpoint timeline</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Trace the ordered touchpoints leading to a specific order — deterministically
            stitched from its anonymous session.
          </p>
        </div>
        <TouchpointTimeline />
      </section>
    </div>
  );
}

function JourneyMixData({
  mix,
  stitch,
}: {
  mix: FirstTouchHasData;
  stitch: StitchHasData | null;
}) {
  const total = BigInt(mix.total);
  // real_touch_count / synthetic_touch_count are not in the core DTO — coverage is
  // derived from total distinct journeys. data_source='synthetic' signals the window
  // is synthetic-enriched.
  const totalN = Number(total);
  const coverageSub =
    mix.data_source === 'synthetic'
      ? `${totalN.toLocaleString('en-IN')} journeys (synthetic-enriched)`
      : `${totalN.toLocaleString('en-IN')} distinct journeys`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Distinct journeys"
          value={Number(total).toLocaleString('en-IN')}
          sublabel={`${mix.from} → ${mix.to}`}
          data-testid="journey-kpi-total"
        />

        {stitch ? (
          <StitchRateCard
            hitPct={stitch.hit_pct}
            stitched={stitch.stitched}
            total={stitch.total}
            data-testid="journey-kpi-stitch"
          />
        ) : (
          <KpiTile
            label="Cart-stitch hit-rate"
            value={null}
            sublabel="deterministic anon → order"
            data-testid="journey-kpi-stitch"
          />
        )}

        <KpiTile
          label="Touchpoint coverage"
          value={totalN.toLocaleString('en-IN')}
          sublabel={coverageSub}
          data-testid="journey-kpi-coverage"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Journeys by first-touch channel
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FirstTouchMixChart rows={mix.by_channel} />
        </CardContent>
      </Card>
    </div>
  );
}
