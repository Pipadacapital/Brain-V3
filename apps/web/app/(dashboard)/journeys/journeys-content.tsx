'use client';

/**
 * JourneysContent — Tab #6 "How do customers move from first visit to purchase?".
 *
 * Composes the BFF metric-engine journey surface (all read over silver_touchpoint via the Trino
 * serving seam, never the lakehouse directly) into the redesigned IA's TabShell frame:
 *   - a REAL aggregate visit→purchase PATH FLOW (the #32a gold_journey_paths Sankey: the top ordered
 *     channel paths with per-path converted-vs-dropped drop-off + the aggregated channel transitions),
 *   - the first-touch channel mix + deterministic cart-stitch rate,
 *   - the per-order touchpoint timeline.
 *
 * REUSE, don't rebuild: the leaf components (FirstTouchMixChart, StitchRateCard, TouchpointTimeline,
 * SyntheticBadge, channelMeta) + the hooks (useJourneyPaths, useJourneyFirstTouchMix,
 * useJourneyStitchRate) are wired pieces — this file composes + frames them.
 *
 * The #32a path flow REPLACES the earlier interim storefront-funnel stand-in: it is now a true
 * aggregate path Sankey (ordered channel paths + edges + per-path drop-off), not a stage funnel.
 *
 * The path flow is a brand-wide aggregate (no date range); the date range scopes the first-touch mix
 * and cart-stitch sections; the touchpoint timeline picks a single order for the per-journey trace.
 *
 * Honesty: SyntheticBadge stays visible whenever the BFF returns data_source='synthetic'; FreshnessBadge
 * renders tone='unknown' because the journey/path endpoints expose no served-at timestamp (never a
 * fabricated "just now"); per-path conversion % is the engine's exact integer-basis-point string (never
 * re-divided in the client); empty states explain WHY they're empty + link pixel setup (never a fake zero).
 */

import { useState } from 'react';
import Link from 'next/link';
import { Footprints, GitBranch, ArrowRight, Layers, ChevronRight } from 'lucide-react';
import { TabShell } from '@/components/ui/tab-shell';
import { SectionCard } from '@/components/ui/section-card';
import { EmptyState } from '@/components/ui/empty-state';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { FirstTouchMixChart } from '@/components/analytics/first-touch-mix-chart';
import { StitchRateCard } from '@/components/analytics/stitch-rate-card';
import { TouchpointTimeline } from '@/components/analytics/touchpoint-timeline';
import { channelMeta } from '@/components/analytics/channel-meta';
import {
  DateRangeFilter,
  initialRange,
  type DateRange,
  type RangePreset,
} from '@/components/ui/date-range-filter';
import {
  useJourneyFirstTouchMix,
  useJourneyStitchRate,
  useJourneyPaths,
} from '@/lib/hooks/use-analytics';
import type {
  AnalyticsJourneyFirstTouchMixResponse,
  AnalyticsJourneyStitchRateResponse,
  AnalyticsJourneyPathsResponse,
} from '@/lib/api/types';

type FirstTouchHasData = Extract<AnalyticsJourneyFirstTouchMixResponse, { state: 'has_data' }>;
type StitchHasData = Extract<AnalyticsJourneyStitchRateResponse, { state: 'has_data' }>;
type PathsHasData = Extract<AnalyticsJourneyPathsResponse, { state: 'has_data' }>;

/** Longer windows than the default 7/30/90 — journeys accrue over months. */
const JOURNEY_PRESETS: readonly RangePreset[] = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '180', label: 'Last 180 days', days: 180 },
];

function num(s: string): string {
  return Number(s).toLocaleString('en-IN');
}

const EXPLAINER = {
  title: 'Journeys — visit → purchase',
  description:
    'How customers travel from their first touch to a purchase: the most common channel PATHS (with per-path drop-off), the first-touch channel mix, the deterministic cart-stitch rate, and per-order touchpoint timelines.',
  metrics: [
    {
      name: 'Path flow (Sankey)',
      definition: 'The most-common ordered channel paths customers take to a purchase, ranked by journey count.',
      howComputed: 'silver_touchpoint pre-aggregated into the gold_journey_paths mart (top paths per brand) via useJourneyPaths. Per-path conversion % is exact integer basis points from the engine — never re-divided in the client.',
    },
    {
      name: 'Per-path drop-off',
      definition: 'Of the journeys that took a path, how many converted versus dropped before an order.',
      howComputed: 'journey_count − converted_count per path (both exact integer counts from the mart). Aggregated channel→channel edges show where journey volume concentrates.',
    },
    {
      name: 'First-touch mix',
      definition: 'Which channel first brought each converting journey (count + share by channel).',
      howComputed: 'First touch per journey over silver_touchpoint (useJourneyFirstTouchMix). Shares are integer basis points from the engine — never re-divided in the client.',
    },
    {
      name: 'Cart-stitch rate',
      definition: 'Share of anonymous journeys deterministically linked to a known customer/order.',
      howComputed: 'Distinct anon journeys stitched to a brain_id (read back from the order — never inferred) ÷ all anon journeys (useJourneyStitchRate). Null when there are no journeys.',
    },
    {
      name: 'Touchpoint timeline',
      definition: 'The ordered touchpoints leading to one specific order — trace a single journey end-to-end.',
      howComputed: 'silver_touchpoint touches (touch_seq asc) for the order’s stitched anon journey (useJourneyTimeline).',
    },
  ],
  sections: [
    {
      heading: 'Reading the path flow',
      body: 'Each row is one ordered channel path (e.g. Paid · Meta → Email → Direct), ranked by how many journeys took it. The split bar shows converted vs dropped journeys on that path — the per-path drop-off. The path flow is a brand-wide aggregate; it does not use the date range.',
    },
    {
      heading: 'Pick a window or an order',
      body: 'The date range scopes the first-touch mix and cart-stitch sections. To trace one journey, search an order in the Touchpoint timeline — it resolves that order’s stitched anonymous session into its ordered touches.',
    },
    {
      heading: 'Live vs synthetic',
      body: 'Journey data carries a data_source flag from the BFF. When real page-view coverage is thin a window may be enriched with clearly-labelled synthetic fixtures; whenever that happens the “Synthetic” badge stays visible and nothing is presented as live.',
    },
  ],
  refreshCadence:
    'Journey + path marts refresh on the Silver→Gold loop. These endpoints expose no served-at timestamp, so freshness reads “unknown” rather than a fabricated time.',
  sources: [
    'silver_touchpoint',
    'gold_journey_paths / mv_gold_journey_paths (path flow)',
    'Journey first-touch / stitch marts',
  ],
};

/** Honest empty surface with a pixel-setup CTA (never a fabricated zero). */
function EmptyPixel({ message }: { message: string }) {
  return (
    <EmptyState
      icon={<Footprints />}
      title="No journeys yet"
      description={message}
      action={
        <Link href="/settings/pixel">
          <Button variant="outline" size="sm">
            Set up the Brain Pixel
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </Link>
      }
    />
  );
}

export function JourneysContent() {
  const [range, setRange] = useState<DateRange>(() => initialRange(JOURNEY_PRESETS, '90'));

  // The path flow is a brand-wide aggregate (gold_journey_paths) — it does NOT use the date range.
  const pathsQ = useJourneyPaths({ limit: 12 });
  const mixQ = useJourneyFirstTouchMix({ from: range.from, to: range.to });
  const stitchQ = useJourneyStitchRate({ from: range.from, to: range.to });

  const mix = mixQ.data;
  const stitch = stitchQ.data;
  const paths = pathsQ.data;

  const synthetic =
    (mix?.state === 'has_data' && mix.data_source === 'synthetic') ||
    (stitch?.state === 'has_data' && stitch.data_source === 'synthetic') ||
    (paths?.state === 'has_data' && paths.data_source === 'synthetic');

  return (
    <TabShell
      title="Journeys"
      description="How do customers move from first visit to purchase?"
      explainer={EXPLAINER}
      actions={
        <DateRangeFilter
          value={range}
          onChange={setRange}
          presets={JOURNEY_PRESETS}
          aria-label="Journey date range"
        />
      }
    >
      {/* ── Visit → purchase PATH flow (real Sankey/path-flow + per-path drop-off) ── */}
      <SectionCard
        title={
          <span className="inline-flex items-center gap-2">
            <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
            Visit → purchase paths
          </span>
        }
        description="The most common ordered channel paths customers take to a purchase, ranked by journeys — with the converted-vs-dropped split per path. Brand-wide aggregate over gold_journey_paths."
        actions={
          synthetic ? (
            <SyntheticBadge
              data-testid="journey-paths-synthetic-badge"
              reason="Real page-view coverage is thin, so path data is enriched with clearly-labelled synthetic journey fixtures (real shape, synthetic source). Never presented as live."
            />
          ) : undefined
        }
        meta={<FreshnessBadge timestamp={undefined} />}
      >
        {pathsQ.isLoading && <PathsSkeleton />}
        {!pathsQ.isLoading && pathsQ.error && (
          <ErrorCard error={pathsQ.error} retry={pathsQ.refetch} />
        )}
        {!pathsQ.isLoading && !pathsQ.error && paths?.state === 'no_data' && (
          <EmptyPixel message="The path flow appears once the Brain Pixel captures multi-touch journeys over silver_touchpoint and those journeys are aggregated into the gold_journey_paths mart." />
        )}
        {!pathsQ.isLoading && !pathsQ.error && paths?.state === 'has_data' && (
          <PathFlow data={paths} />
        )}
      </SectionCard>

      {/* ── First-touch channel mix + cart-stitch rate ── */}
      <SectionCard
        title={
          <span className="inline-flex items-center gap-2">
            <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
            First-touch mix &amp; cart-stitch rate
          </span>
        }
        description="Which channel first brought each journey, and how much anonymous traffic we deterministically link to known orders."
        actions={
          synthetic ? (
            <SyntheticBadge
              data-testid="journey-synthetic-badge"
              reason="Real page-view coverage is thin in this window, so it is enriched with clearly-labelled synthetic journey fixtures (real shape, synthetic source). Never presented as live."
            />
          ) : undefined
        }
        meta={<FreshnessBadge timestamp={undefined} />}
      >
        {mixQ.isLoading && <MixSkeleton />}
        {!mixQ.isLoading && mixQ.error && <ErrorCard error={mixQ.error} retry={mixQ.refetch} />}
        {!mixQ.isLoading && !mixQ.error && mix?.state === 'no_data' && (
          <EmptyPixel message="First-touch mix and the cart-stitch rate build from pixel touchpoints with UTM / click-id context in the Silver tier." />
        )}
        {!mixQ.isLoading && !mixQ.error && mix?.state === 'has_data' && (
          <JourneyMix mix={mix} stitch={stitch?.state === 'has_data' ? stitch : null} />
        )}
      </SectionCard>

      {/* ── Per-order touchpoint timeline (trace one journey) ── */}
      <SectionCard
        title={
          <span className="inline-flex items-center gap-2">
            <Footprints className="size-4 text-muted-foreground" aria-hidden="true" />
            Trace one journey
          </span>
        }
        description="Search an order to see its ordered touchpoints — the anonymous session deterministically stitched into the purchase."
        meta={<FreshnessBadge timestamp={undefined} />}
      >
        <TouchpointTimeline />
      </SectionCard>
    </TabShell>
  );
}

/** A compact ordered channel-path chip row: Paid · Meta → Email → Direct (icon + label per node). */
function PathChips({ channels }: { channels: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {channels.map((ch, i) => {
        const m = channelMeta(ch);
        const Icon = m.icon;
        return (
          <span key={`${ch}-${i}`} className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
              <Icon className="size-3 text-muted-foreground" aria-hidden="true" />
              {m.label}
            </span>
            {i < channels.length - 1 && (
              <ChevronRight className="size-3 text-muted-foreground" aria-hidden="true" />
            )}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The aggregate journey-path flow: KPI headline + the top ordered channel paths, each with its
 * journey count, conversion %, and a converted-vs-dropped split bar (the per-path drop-off).
 * Integer counts; conversion % is the engine's exact 2dp string (never re-divided in the client).
 */
function PathFlow({ data }: { data: PathsHasData }) {
  // Scale path bars by the busiest path's journey count (visual geometry only; counts are exact).
  const maxJourneys = data.paths.reduce((m, p) => {
    const v = Number(BigInt(p.journey_count));
    return v > m ? v : m;
  }, 0);
  const scale = maxJourneys || 1;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Distinct paths"
          value={data.total_paths.toLocaleString('en-IN')}
          sublabel="unique channel routes"
          data-testid="journey-paths-kpi-paths"
        />
        <KpiTile
          label="Journeys"
          value={num(data.total_journeys)}
          sublabel="across all paths"
          data-testid="journey-paths-kpi-journeys"
        />
        <KpiTile
          label="Overall conversion"
          value={data.overall_conversion_pct != null ? `${data.overall_conversion_pct}%` : '—'}
          sublabel="journeys that converted"
          data-testid="journey-paths-kpi-conversion"
        />
      </div>

      <ul className="space-y-4" aria-label="Top visit → purchase channel paths">
        {data.paths.map((p) => {
          const journeys = Number(BigInt(p.journey_count));
          const converted = Number(BigInt(p.converted_count));
          const dropped = Number(BigInt(p.dropped_count));
          const widthPct = Math.max(journeys > 0 ? 6 : 0, Math.min(100, (journeys / scale) * 100));
          // Converted share of the journey bar (visual split only; the counts beside it are exact).
          const convFillPct = journeys > 0 ? Math.min(100, (converted / journeys) * 100) : 0;
          return (
            <li key={p.path_signature} className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <PathChips channels={p.channels} />
                <span className="tabular-nums text-sm text-muted-foreground">
                  {journeys.toLocaleString('en-IN')} journeys
                  {p.conversion_pct != null && (
                    <span className="ml-2 text-foreground">{p.conversion_pct}% conv.</span>
                  )}
                </span>
              </div>
              {/* Journey-volume bar with a converted (solid) vs dropped (muted) split. */}
              <div
                className="h-3 overflow-hidden rounded bg-muted"
                style={{ width: `${widthPct}%` }}
                aria-hidden="true"
              >
                <div className="h-full bg-foreground/70" style={{ width: `${convFillPct}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">
                <span className="text-foreground">{converted.toLocaleString('en-IN')}</span> converted
                {' · '}
                <span className="text-foreground">{dropped.toLocaleString('en-IN')}</span> dropped
              </p>
            </li>
          );
        })}
      </ul>

      {data.links.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">
            Where journeys flow (channel transitions)
          </p>
          <ul className="space-y-1.5" aria-label="Aggregated channel transitions">
            {data.links.slice(0, 8).map((l, i) => (
              <li
                key={`${l.step}-${l.from_channel}-${l.to_channel}-${i}`}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-foreground">{channelMeta(l.from_channel).label}</span>
                  <ChevronRight className="size-3 text-muted-foreground" aria-hidden="true" />
                  <span className="text-foreground">{channelMeta(l.to_channel).label}</span>
                </span>
                <span className="tabular-nums text-muted-foreground">{num(l.journeys)} journeys</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function JourneyMix({ mix, stitch }: { mix: FirstTouchHasData; stitch: StitchHasData | null }) {
  const total = BigInt(mix.total);
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
          label="Data source"
          value={mix.data_source === 'synthetic' ? 'Synthetic-enriched' : 'Live'}
          sublabel={mix.data_source === 'synthetic' ? 'dev preview data' : 'from your pixel'}
          data-testid="journey-kpi-coverage"
        />
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-muted-foreground">
          Journeys by first-touch channel
        </p>
        <FirstTouchMixChart rows={mix.by_channel} />
      </div>
    </div>
  );
}

function PathsSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading visit → purchase paths…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function MixSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading first-touch mix…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
