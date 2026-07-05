'use client';

/**
 * JourneysContent — Tab #6 "How do customers move from first visit to purchase?".
 *
 * Plain-language slice: every metric title carries a "?" one-sentence tooltip (MetricTitle),
 * internal event codes never reach the DOM (the trace section renders through the shared
 * <JourneyTimeline>, which humanizes via lib/event-labels), and estimated/partial data is
 * marked with the shared SyntheticBadge ("Estimated").
 *
 * Composes the BFF metric-engine journey surface (all read over the Trino serving seam,
 * never the lakehouse directly):
 *   - "Ranked conversion paths" — the gold_journey_paths aggregate as a table
 *     (Path as channel chips · Conversions · Conversion rate),
 *   - "Which channel first brought visitors" — first-touch mix + the Identified-visitors card,
 *   - "Trace one journey" — order ID → the shared <JourneyTimeline> fed by useJourneyTimeline.
 *
 * Honesty: SyntheticBadge stays visible whenever the BFF returns data_source='synthetic';
 * FreshnessBadge renders tone='unknown' because these endpoints expose no served-at timestamp
 * (never a fabricated "just now"); conversion % is the engine's exact 2dp string (never
 * re-divided in the client); empty states explain WHY they're empty (never a fake zero).
 */

import { useState } from 'react';
import Link from 'next/link';
import { Footprints, GitBranch, ArrowRight, Layers, ChevronRight, Route } from 'lucide-react';
import { TabShell } from '@/components/ui/tab-shell';
import { SectionCard } from '@/components/ui/section-card';
import { EmptyState } from '@/components/ui/empty-state';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { MetricTitle } from '@/components/ui/metric-title';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { FirstTouchMixChart } from '@/components/analytics/first-touch-mix-chart';
import { StitchRateCard } from '@/components/analytics/stitch-rate-card';
import { JourneyTimeline } from '@/components/analytics/journey-timeline';
import { channelMeta } from '@/components/analytics/channel-meta';
import { eventLabel } from '@/lib/event-labels';
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
  useJourneyTimeline,
} from '@/lib/hooks/use-analytics';
import type {
  AnalyticsJourneyFirstTouchMixResponse,
  AnalyticsJourneyStitchRateResponse,
  AnalyticsJourneyPathsResponse,
  JourneyTouchpointRow,
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
    'How customers travel from their first touch to a purchase: the channel paths that lead to orders, which channel first brought visitors, how many anonymous browsers we can identify, and a per-order journey trace.',
  metrics: [
    {
      name: 'Ranked conversion paths',
      definition:
        'The channel sequences visitors take before buying, ranked by how many purchases each path produced.',
      howComputed:
        'Journeys pre-aggregated into the gold_journey_paths mart (top paths per brand) via useJourneyPaths. Conversion % is exact from the engine — never re-divided in the client.',
    },
    {
      name: 'Which channel first brought visitors',
      definition: 'The channel that first brought each visitor to your store (count + share).',
      howComputed:
        'First touch per journey over the Silver journey tier (useJourneyFirstTouchMix). Shares are exact from the engine — never re-divided in the client.',
    },
    {
      name: 'Identified visitors',
      definition:
        'Anonymous browsers we can prove belong to a known customer — linked only by a definitive identifier, never guessed.',
      howComputed:
        'Distinct anonymous journeys linked to a known customer (the identifier is read back from the order — never inferred) ÷ all anonymous journeys (useJourneyStitchRate). Honest null when there are no journeys.',
    },
    {
      name: 'Trace one journey',
      definition: 'Every step one customer took before a specific order — from first visit to purchase.',
      howComputed:
        'The ordered touchpoints of the order’s linked anonymous session (useJourneyTimeline), rendered in plain language.',
    },
  ],
  sections: [
    {
      heading: 'Reading the paths table',
      body: 'Each row is one ordered channel path (e.g. Paid · Meta → Email → Direct). "Conversions" is how many journeys on that path ended in a purchase; "Conversion rate" is that share of everyone who took the path. The table is a brand-wide aggregate; it does not use the date range.',
    },
    {
      heading: 'Pick a window or an order',
      body: 'The date range scopes the first-touch mix and Identified-visitors sections. To trace one journey, enter an order ID in "Trace one journey" — it shows every tracked step that led to that order.',
    },
    {
      heading: 'Live vs estimated',
      body: 'Journey data carries a data_source flag from the BFF. When real tracking coverage is thin a window may be filled in with clearly-labelled estimated data; whenever that happens the "Estimated" badge stays visible and nothing is presented as live.',
    },
  ],
  refreshCadence:
    'Journey + path marts refresh on the Silver→Gold loop. These endpoints expose no served-at timestamp, so freshness reads “unknown” rather than a fabricated time.',
  sources: [
    'silver_touchpoint',
    'gold_journey_paths / mv_gold_journey_paths (ranked paths)',
    'Journey first-touch / identified-visitors marts',
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

  // The paths table is a brand-wide aggregate (gold_journey_paths) — it does NOT use the date range.
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
      {/* ── Ranked conversion paths (gold_journey_paths aggregate) ── */}
      <SectionCard
        title={
          <span className="inline-flex items-center gap-2">
            <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
            <MetricTitle
              label="Ranked conversion paths"
              help="The sequence of channels a customer interacted with before buying, ranked by how many purchases each path produced."
            />
          </span>
        }
        description="Each row is one channel route customers take on the way to an order — with how many bought and what share that is of everyone who took the path."
        actions={
          synthetic ? (
            <SyntheticBadge
              data-testid="journey-paths-synthetic-badge"
              reason="Real tracking coverage is thin, so path data includes clearly-labelled estimated journeys. Never presented as live."
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
          <EmptyPixel message="Conversion paths appear once the Brain Pixel captures visits across more than one channel and those journeys lead to orders." />
        )}
        {!pathsQ.isLoading && !pathsQ.error && paths?.state === 'has_data' && (
          <RankedPathsTable data={paths} />
        )}
      </SectionCard>

      {/* ── First-touch channel mix + identified visitors ── */}
      <SectionCard
        title={
          <span className="inline-flex items-center gap-2">
            <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
            <MetricTitle
              label="Which channel first brought visitors"
              help="The channel that first brought each visitor to your store, before anything else happened."
            />
          </span>
        }
        description="Where journeys begin — and how many anonymous browsers we can prove belong to a known customer."
        actions={
          synthetic ? (
            <SyntheticBadge
              data-testid="journey-synthetic-badge"
              reason="Real tracking coverage is thin in this window, so it includes clearly-labelled estimated journeys. Never presented as live."
            />
          ) : undefined
        }
        meta={<FreshnessBadge timestamp={undefined} />}
      >
        {mixQ.isLoading && <MixSkeleton />}
        {!mixQ.isLoading && mixQ.error && <ErrorCard error={mixQ.error} retry={mixQ.refetch} />}
        {!mixQ.isLoading && !mixQ.error && mix?.state === 'no_data' && (
          <EmptyPixel message="This chart builds from the first tracked visit of each journey — it appears once the Brain Pixel starts capturing visits." />
        )}
        {!mixQ.isLoading && !mixQ.error && mix?.state === 'has_data' && (
          <JourneyMix mix={mix} stitch={stitch?.state === 'has_data' ? stitch : null} />
        )}
      </SectionCard>

      {/* ── Trace one journey (order → shared JourneyTimeline) ── */}
      <SectionCard
        title={
          <span className="inline-flex items-center gap-2">
            <Footprints className="size-4 text-muted-foreground" aria-hidden="true" />
            <MetricTitle
              label="Trace one journey"
              help="Every tracked step one customer took before a specific order — from first visit to purchase."
            />
          </span>
        }
        description="Enter an order ID to see the visits, ads, and actions that led up to that purchase."
        meta={<FreshnessBadge timestamp={undefined} />}
      >
        <TraceOneJourney />
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
 * Ranked conversion paths — KPI headline + a table of the top ordered channel paths
 * (Path chips · Conversions · Conversion rate), ranked by conversions. Integer counts;
 * conversion % is the engine's exact 2dp string (never re-divided in the client).
 */
function RankedPathsTable({ data }: { data: PathsHasData }) {
  // Rank by purchases (exact integer compare — no float math).
  const ranked = [...data.paths].sort((a, b) =>
    BigInt(b.converted_count) > BigInt(a.converted_count)
      ? 1
      : BigInt(b.converted_count) < BigInt(a.converted_count)
        ? -1
        : 0,
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Distinct paths"
          help="How many different channel routes customers took on the way to your store."
          value={data.total_paths.toLocaleString('en-IN')}
          sublabel="unique channel routes"
          data-testid="journey-paths-kpi-paths"
        />
        <KpiTile
          label="Journeys"
          help="How many visitor journeys we tracked across all paths."
          value={num(data.total_journeys)}
          sublabel="across all paths"
          data-testid="journey-paths-kpi-journeys"
        />
        <KpiTile
          label="Overall conversion"
          help="Of all tracked journeys, the share that ended in a purchase."
          value={data.overall_conversion_pct != null ? `${data.overall_conversion_pct}%` : null}
          sublabel="journeys that ended in a purchase"
          data-testid="journey-paths-kpi-conversion"
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Path</TableHead>
            <TableHead numeric>Conversions</TableHead>
            <TableHead numeric>Conversion rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ranked.map((p) => (
            <TableRow key={p.path_signature}>
              <TableCell>
                <PathChips channels={p.channels} />
              </TableCell>
              <TableCell numeric className="tabular-nums">
                {num(p.converted_count)}
                <span className="ml-1 text-xs text-muted-foreground">
                  of {num(p.journey_count)}
                </span>
              </TableCell>
              <TableCell numeric className="tabular-nums">
                {p.conversion_pct != null ? `${p.conversion_pct}%` : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {data.links.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">
            <MetricTitle
              label="Where journeys flow next"
              help="For visitors who touched more than one channel, the most common channel-to-channel hand-offs."
            />
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
  const estimated = mix.data_source === 'synthetic';
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Visitor journeys"
          help="How many distinct visitor journeys started in the selected period."
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
            label="Identified visitors"
            help="We only link an anonymous visitor to a known customer when we see a definitive identifier (like an email used at checkout)."
            value={null}
            sublabel="anonymous browsers linked to known customers"
            data-testid="journey-kpi-stitch"
          />
        )}
        <KpiTile
          label="Data source"
          help="Whether these numbers come from your live tracking pixel or include estimated data."
          value={estimated ? 'Estimated' : 'Live'}
          estimated={estimated}
          sublabel={estimated ? 'includes estimated data' : 'from your tracking pixel'}
          data-testid="journey-kpi-coverage"
        />
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-muted-foreground">
          Journeys by the channel that first brought them
        </p>
        <FirstTouchMixChart rows={mix.by_channel} />
      </div>
    </div>
  );
}

// ── Trace one journey — order ID → shared <JourneyTimeline> ──────────────────

/** Plain-language phrase per channel, for "Landed on the homepage (Meta ad)"-style sentences. */
const CHANNEL_PHRASE: Record<string, string> = {
  paid: 'a paid ad',
  paid_meta: 'a Meta ad',
  paid_google: 'a Google ad',
  paid_tiktok: 'a TikTok ad',
  email: 'an email link',
  organic_social: 'social media',
  referral: 'a link on another site',
  direct: 'a direct visit',
};

/** Human page name from a landing path ('/' → 'the homepage', '/products/x' → 'products/x'). */
function pageName(path: string | null): string | null {
  if (!path) return null;
  if (path === '/' || path === '') return 'the homepage';
  return path.replace(/^\//, '');
}

/**
 * Compose a plain-language sentence for one touchpoint — "Landed on the homepage (a Meta ad)"
 * style — from the channel + humanized event label + page/campaign context on the row.
 * Never renders the raw event code (eventLabel humanizes internally).
 */
function describeTouch(t: JourneyTouchpointRow): string {
  const phrase = CHANNEL_PHRASE[t.channel];
  const page = pageName(t.landing_path);
  const via = phrase ? ` (${phrase})` : '';

  let base: string;
  if (t.is_first_touch) {
    base = page ? `Landed on ${page}${via}` : `Arrived at the store${via}`;
  } else if (page) {
    base = `Visited ${page}${via}`;
  } else {
    base = `${eventLabel(t.event_type).description}${via}`;
  }

  const campaign = t.utm_campaign ? ` — campaign “${t.utm_campaign}”` : '';
  const referrer = !t.utm_campaign && t.referrer_host ? ` — came from ${t.referrer_host}` : '';
  return `${base}${campaign}${referrer}`;
}

/**
 * TraceOneJourney — order-ID input → the shared <JourneyTimeline>, fed by the EXISTING
 * useJourneyTimeline hook (touchpoint rows mapped inline). Oldest-first: the story reads
 * top-to-bottom from first visit to purchase. Honest empty state when the order has no
 * linked session — never a fabricated step.
 */
function TraceOneJourney() {
  const [draft, setDraft] = useState('');
  const [orderId, setOrderId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useJourneyTimeline(orderId);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    setOrderId(v.length > 0 ? v : null);
  };

  const hasData = data?.state === 'has_data';

  return (
    <div className="space-y-3" data-testid="journey-timeline-section">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="journey-order-id" className="text-xs font-medium text-muted-foreground">
            Enter an order ID
          </label>
          <input
            id="journey-order-id"
            type="text"
            inputMode="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. 4521987654321"
            data-testid="journey-order-input"
            className="h-9 w-64 max-w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" data-testid="journey-timeline-submit">
          <Route className="mr-2 h-4 w-4" aria-hidden="true" />
          Trace journey
        </Button>
      </form>

      {orderId === null && (
        <EmptyState
          compact
          icon={<Route />}
          title="Trace a customer's journey"
          description="Enter an order ID above to see every tracked step that led to that purchase — from first visit onwards."
        />
      )}

      {orderId !== null && isLoading && <JourneyTimeline events={[]} loading />}

      {orderId !== null && !isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {orderId !== null && !isLoading && !error && data?.state === 'no_data' && (
        <EmptyState
          compact
          icon={<Footprints />}
          title="No linked visit history for this order"
          description={`We couldn't connect order ${orderId} to a browsing session. We only make that link when the session is definitively tied to the order at checkout — we never guess.`}
        />
      )}

      {orderId !== null && !isLoading && !error && hasData && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              Journey for order <span className="font-mono">{orderId}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              · {data.touches.length} step{data.touches.length === 1 ? '' : 's'}
            </span>
            {data.data_source === 'synthetic' && (
              <SyntheticBadge
                data-testid="journey-timeline-synthetic-badge"
                reason="This journey is built from clearly-labelled estimated data so the timeline is demoable — live tracking replaces it as coverage grows."
              />
            )}
          </div>

          {data.touches.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              This order is linked to a session, but no steps were recorded for it.
            </p>
          ) : (
            <JourneyTimeline
              events={[...data.touches]
                .sort((a, b) => a.touch_seq - b.touch_seq)
                .map((t) => ({
                  id: String(t.touch_seq),
                  occurredAt: t.occurred_at,
                  eventType: t.event_type,
                  channel: t.channel,
                  description: describeTouch(t),
                }))}
            />
          )}
        </div>
      )}
    </div>
  );
}

function PathsSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading conversion paths…">
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
