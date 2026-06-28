'use client';

/**
 * JourneysContent — Tab #6 "How do customers move from first visit to purchase?".
 *
 * Re-homes the existing analytics/journey surface (first-touch channel mix + deterministic
 * cart-stitch rate + per-order touchpoint timeline — all read via the BFF metric-engine journey
 * seam over silver_touchpoint, never StarRocks directly) into the redesigned IA's TabShell frame,
 * and adds an honest visit→purchase STAGE drop-off (the storefront funnel) as the closest available
 * stand-in for an aggregate path flow.
 *
 * REUSE, don't rebuild: the leaf components (FirstTouchMixChart, StitchRateCard, TouchpointTimeline,
 * SyntheticBadge) + the hooks (useJourneyFirstTouchMix, useJourneyStitchRate, useFunnelAnalytics)
 * are the existing, wired pieces — this file only composes + frames them.
 *
 * GENUINE GAP (flagged as an openItem, NOT faked): there is no aggregate multi-step visit→purchase
 * Sankey / path-edge drop-off endpoint today — only first-touch mix, stitch rate, and a single-order
 * timeline. A true Sankey needs a NEW BFF aggregate over silver_touchpoint (path edges + drop-off)
 * plus a Sankey viz. Until then the storefront funnel (sessions→product→cart→purchase) carries the
 * stage drop-off, clearly labelled as a stage funnel rather than a path flow.
 *
 * "Pick customer or cohort": the date range scopes the cohort window for the aggregate sections; the
 * touchpoint timeline picks a single order/customer (its own order search) for the per-journey trace.
 *
 * Honesty: SyntheticBadge stays visible whenever the BFF returns data_source='synthetic'; FreshnessBadge
 * renders tone='unknown' because the journey/funnel endpoints expose no served-at timestamp (never a
 * fabricated "just now"); empty states explain WHY they're empty + link pixel setup (never a fake zero).
 */

import { useState } from 'react';
import Link from 'next/link';
import { Footprints, GitBranch, ArrowRight, Layers } from 'lucide-react';
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
import {
  DateRangeFilter,
  initialRange,
  type DateRange,
  type RangePreset,
} from '@/components/ui/date-range-filter';
import {
  useJourneyFirstTouchMix,
  useJourneyStitchRate,
  useFunnelAnalytics,
} from '@/lib/hooks/use-analytics';
import type {
  AnalyticsJourneyFirstTouchMixResponse,
  AnalyticsJourneyStitchRateResponse,
  AnalyticsFunnelResponse,
} from '@/lib/api/types';

type FirstTouchHasData = Extract<AnalyticsJourneyFirstTouchMixResponse, { state: 'has_data' }>;
type StitchHasData = Extract<AnalyticsJourneyStitchRateResponse, { state: 'has_data' }>;
type FunnelHasData = Extract<AnalyticsFunnelResponse, { state: 'has_data' }>;

/** Longer windows than the default 7/30/90 — journeys accrue over months. */
const JOURNEY_PRESETS: readonly RangePreset[] = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '180', label: 'Last 180 days', days: 180 },
];

/** Friendly labels for the four storefront-funnel stage keys emitted by the engine. */
const STAGE_LABELS: Record<string, string> = {
  sessions: 'Sessions',
  product_viewed: 'Viewed a product',
  cart_added: 'Added to cart',
  purchased: 'Purchased',
};

function num(s: string): string {
  return Number(s).toLocaleString('en-IN');
}

const EXPLAINER = {
  title: 'Journeys — visit → purchase',
  description:
    'How customers travel from their first touch to a purchase: stage drop-off, first-touch channel mix, the deterministic cart-stitch rate, and per-order touchpoint timelines.',
  metrics: [
    {
      name: 'Stage drop-off (funnel)',
      definition: 'Share of storefront sessions that reach each stage: session → product view → cart → purchase.',
      howComputed: 'Sessions stitched to events over silver_touchpoint (useFunnelAnalytics). Conversion % is vs the funnel top; step % is vs the previous stage — both 2dp from the engine.',
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
      heading: 'Stage funnel vs aggregate path Sankey',
      body: 'The stage funnel below is a STAGE drop-off (how far sessions get), not a full path flow. A true visit→purchase Sankey (path edges + per-path drop-off across every route customers take) needs a new backend aggregate over silver_touchpoint — flagged as a follow-up, never faked here.',
    },
    {
      heading: 'Pick a window or an order',
      body: 'The date range scopes the cohort window for the aggregate sections. To trace one journey, search an order in the Touchpoint timeline — it resolves that order’s stitched anonymous session into its ordered touches.',
    },
    {
      heading: 'Live vs synthetic',
      body: 'Journey data carries a data_source flag from the BFF. When real page-view coverage is thin a window may be enriched with clearly-labelled synthetic fixtures; whenever that happens the “Synthetic” badge stays visible and nothing is presented as live.',
    },
  ],
  refreshCadence:
    'Journey + funnel marts refresh on the Silver→Gold loop. These endpoints expose no served-at timestamp, so freshness reads “unknown” rather than a fabricated time.',
  sources: [
    'silver_touchpoint',
    'Journey first-touch / stitch marts',
    'Storefront funnel (metric-engine seam)',
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

  const funnelQ = useFunnelAnalytics({ from: range.from, to: range.to });
  const mixQ = useJourneyFirstTouchMix({ from: range.from, to: range.to });
  const stitchQ = useJourneyStitchRate({ from: range.from, to: range.to });

  const mix = mixQ.data;
  const stitch = stitchQ.data;
  const funnel = funnelQ.data;

  const synthetic =
    (mix?.state === 'has_data' && mix.data_source === 'synthetic') ||
    (stitch?.state === 'has_data' && stitch.data_source === 'synthetic');

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
      {/* ── Visit → purchase stage drop-off (funnel stand-in for the path Sankey) ── */}
      <SectionCard
        title={
          <span className="inline-flex items-center gap-2">
            <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
            Visit → purchase flow
          </span>
        }
        description="How far storefront sessions get on the way to a purchase. This is a stage drop-off — a full aggregate path Sankey is a flagged follow-up."
        meta={<FreshnessBadge timestamp={undefined} />}
      >
        {funnelQ.isLoading && <FunnelSkeleton />}
        {!funnelQ.isLoading && funnelQ.error && (
          <ErrorCard error={funnelQ.error} retry={funnelQ.refetch} />
        )}
        {!funnelQ.isLoading && !funnelQ.error && funnel?.state === 'no_data' && (
          <EmptyPixel message="The visit→purchase funnel appears once the Brain Pixel captures sessions, product views and cart adds — and orders are stitched back to those sessions." />
        )}
        {!funnelQ.isLoading && !funnelQ.error && funnel?.state === 'has_data' && (
          <FunnelFlow data={funnel} />
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

/** Visit→purchase stage bars (reuses the storefront funnel shape; integer counts, engine 2dp %). */
function FunnelFlow({ data }: { data: FunnelHasData }) {
  const byKey = (k: string) => data.stages.find((s) => s.key === k);
  const sessions = byKey('sessions');
  const cart = byKey('cart_added');
  const purchased = byKey('purchased');

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Sessions"
          value={sessions ? num(sessions.sessions) : '0'}
          sublabel={`${data.from} → ${data.to}`}
        />
        <KpiTile
          label="Cart-add rate"
          value={cart?.conversion_pct != null ? `${cart.conversion_pct}%` : '—'}
          sublabel="sessions that added to cart"
        />
        <KpiTile
          label="Purchase rate"
          value={purchased?.conversion_pct != null ? `${purchased.conversion_pct}%` : '—'}
          sublabel="sessions that converted"
        />
      </div>

      <ul className="space-y-3" aria-label="Visit → purchase stages">
        {data.stages.map((s, i) => {
          const widthPct = Math.min(100, Number(s.conversion_pct ?? 0));
          return (
            <li key={s.key}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="text-foreground">{STAGE_LABELS[s.key] ?? s.key}</span>
                <span className="tabular-nums text-muted-foreground">
                  {num(s.sessions)}
                  {s.conversion_pct !== null && (
                    <span className="ml-2 text-foreground">{s.conversion_pct}%</span>
                  )}
                  {i > 0 && s.step_pct !== null && (
                    <span className="ml-2 text-xs">({s.step_pct}% of prev)</span>
                  )}
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded bg-muted" aria-hidden="true">
                <div className="h-full bg-foreground/70" style={{ width: `${widthPct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
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

function FunnelSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading visit → purchase flow…">
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
