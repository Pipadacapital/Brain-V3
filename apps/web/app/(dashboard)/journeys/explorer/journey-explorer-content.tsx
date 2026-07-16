'use client';

/**
 * JourneyExplorerContent — the Wave-B journey deep-dive (Journeys › Explorer).
 *
 * Two lenses onto the reconstructed journey, each honest-empty end to end:
 *   1. Trace an order — resolve an order_id to the ordered list of touches that preceded it
 *      (touch_seq order) + the identity evidence that proves those touches are the same person.
 *      This is "Journey before attribution" made visible: before we credit any channel, we show
 *      the actual path and how we stitched it.
 *   2. Customer timeline — a single customer's (brain_id) newest-first event feed.
 *
 * Reads go ONLY through the use-journey hooks (BFF journey endpoints, the sole read path) — never
 * the serving tier / the ledger directly, never an inlined client-side derivation. Each hook is DISABLED until
 * its input is submitted (the *committed* value in state, not the live input text), so nothing is
 * fetched until the user asks.
 *
 * Honest states: EmptyState before a search, aria-busy skeletons while loading, ErrorCard (with a
 * support reference) on error, and an explained EmptyState on a no_data response — never a
 * fabricated timeline. Raw event codes never reach the DOM: everything goes through eventLabel().
 */

import { useState } from 'react';
import {
  Search,
  MapPin,
  Fingerprint,
  GitBranch,
  Clock,
  User,
  Route,
  ListOrdered,
} from 'lucide-react';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorCard } from '@/components/ui/error-card';
import { useJourneyTrace, useCustomerJourney } from '@/lib/hooks/use-journey';
import { eventLabel } from '@/lib/event-labels';
import type { JourneyTrace, CustomerJourneyTimeline } from '@/lib/api/types';

type TraceHasData = Extract<JourneyTrace, { state: 'has_data' }>;
type TimelineHasData = Extract<CustomerJourneyTimeline, { state: 'has_data' }>;

/**
 * Format a touch/event timestamp readably. Handles both shapes the journey lanes emit:
 * ISO-8601 strings (serving ledger) and epoch-ms numbers (cache path). Falls back to the raw value
 * if it can't be parsed rather than rendering "Invalid Date".
 */
function formatTs(ts: string | number): string {
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A subtle "matched via …" provenance badge; renders a quiet em-dash when we don't know yet. */
function MatchedViaBadge({ matchedVia }: { matchedVia: string | null }) {
  if (!matchedVia) {
    return (
      <span className="text-xs text-muted-foreground/60" title="Stitch provenance not recorded yet">
        —
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
      <GitBranch className="size-3" aria-hidden="true" />
      {matchedVia}
    </span>
  );
}

/** Live-vs-synthetic honesty badge — the data_source is surfaced, never hidden. */
function DataSourceBadge({ source }: { source: 'live' | 'synthetic' }) {
  return (
    <span
      className={
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs ' +
        (source === 'live'
          ? 'border-border bg-muted/60 text-muted-foreground'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400')
      }
      title={
        source === 'live'
          ? 'These touches come from your real, captured data.'
          : 'Synthetic sample data — not your real customers.'
      }
    >
      {source === 'live' ? 'Live data' : 'Synthetic sample'}
    </span>
  );
}

export function JourneyExplorerContent() {
  return (
    <div className="space-y-6" data-testid="journey-explorer">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground">
          <Route className="size-5 text-muted-foreground" aria-hidden="true" />
          Journey Explorer
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Trace the exact path that led to an order, and see the identity evidence that proves those
          touches belong to the same person — journey before attribution. Or open one customer&apos;s
          full timeline.
        </p>
      </header>

      <TraceOrderPanel />
      <CustomerTimelinePanel />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 1. Trace an order — ordered touch timeline + identity evidence
 * ───────────────────────────────────────────────────────────────────────────── */

function TraceOrderPanel() {
  // The live input text vs the *committed* order id that actually drives the (disabled-until-set)
  // hook. The trace is not fetched until the user submits.
  const [input, setInput] = useState('');
  const [orderId, setOrderId] = useState<string | null>(null);

  const traceQ = useJourneyTrace(orderId);
  const trace = traceQ.data;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    setOrderId(trimmed.length > 0 ? trimmed : null);
  }

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <MapPin className="size-4 text-muted-foreground" aria-hidden="true" />
          Trace an order
        </span>
      }
      description="Enter an order ID to see every touch that led to it — in order — and how we knew they were the same customer."
    >
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2" role="search">
        <label htmlFor="trace-order-id" className="sr-only">
          Order ID
        </label>
        <input
          id="trace-order-id"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Order ID (e.g. order_… or #1042)"
          className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="trace-order-input"
        />
        <Button type="submit" size="sm" disabled={input.trim().length === 0}>
          <Search className="size-4" aria-hidden="true" />
          Trace
        </Button>
      </form>

      <div className="mt-5">
        {orderId === null ? (
          <EmptyState
            compact
            icon={<Route />}
            title="Trace a customer journey"
            description="Enter an order ID above to see every touch that led to it — the pages, campaigns and channels in the order they happened — plus the identity evidence behind the stitch."
          />
        ) : traceQ.isLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Tracing journey…">
            <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            <div className="h-16 w-full animate-pulse rounded bg-muted" />
            <div className="h-16 w-full animate-pulse rounded bg-muted" />
          </div>
        ) : traceQ.isError ? (
          <ErrorCard error={traceQ.error} retry={() => traceQ.refetch()} />
        ) : !trace || trace.state === 'no_data' ? (
          <EmptyState
            compact
            icon={<MapPin />}
            title="No journey found"
            description={`We couldn't find a stitched journey for order "${orderId}". It may be too new to have been processed, or its touches aren't linked to an identity yet (unstitched).`}
            hint="Double-check the order ID, or try again after the next journey refresh."
          />
        ) : (
          <TraceResult trace={trace} />
        )}
      </div>
    </SectionCard>
  );
}

/** The two-column trace result: ordered touch timeline (left) + identity evidence proof (right). */
function TraceResult({ trace }: { trace: TraceHasData }) {
  // Defensive: render touches in touch_seq order regardless of server ordering.
  const touches = [...trace.touches].sort((a, b) => a.touch_seq - b.touch_seq);

  return (
    <div className="space-y-4">
      {/* Header row — brain_id (or the honest anonymous-only note), lookback window, data source. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <User className="size-3.5" aria-hidden="true" />
          {trace.brain_id ? (
            <span className="font-mono text-foreground">{trace.brain_id}</span>
          ) : (
            <span className="italic">anonymous-stitched only</span>
          )}
        </span>
        <span aria-hidden="true">·</span>
        <span>Lookback {trace.lookback_days} days</span>
        <span aria-hidden="true">·</span>
        <DataSourceBadge source={trace.data_source} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* ── Ordered touch timeline (spans 2 cols) ── */}
        <div className="lg:col-span-2">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <ListOrdered className="size-4" aria-hidden="true" />
            Touches leading to this order
            <span className="font-normal text-muted-foreground/70">({touches.length})</span>
          </h3>

          {touches.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="status">
              This order has no recorded touches in the lookback window.
            </p>
          ) : (
            <ol className="relative space-y-3 border-l border-border pl-6">
              {touches.map((t) => {
                const e = eventLabel(t.event_type);
                return (
                  <li
                    key={t.touch_seq}
                    className="relative"
                    data-testid={`trace-touch-${t.touch_seq}`}
                  >
                    {/* Timeline node */}
                    <span
                      className="absolute -left-[31px] flex size-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground"
                      aria-hidden="true"
                    >
                      <e.Icon className="size-3.5" />
                    </span>

                    <div className="rounded-lg border border-border p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{e.label}</p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                            {t.channel && <span>{t.channel}</span>}
                            {t.utm_campaign && (
                              <>
                                {t.channel && <span aria-hidden="true">·</span>}
                                <span>{t.utm_campaign}</span>
                              </>
                            )}
                            {t.landing_path && (
                              <span className="truncate font-mono text-muted-foreground/80">
                                {t.landing_path}
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <Clock className="size-3" aria-hidden="true" />
                            {formatTs(t.occurred_at)}
                          </span>
                          <MatchedViaBadge matchedVia={t.matched_via} />
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {/* ── Identity evidence — "how do we know this is the same person" ── */}
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Fingerprint className="size-4" aria-hidden="true" />
            Identity evidence
          </h3>

          {trace.identity_evidence.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="status">
              No identity evidence recorded — these touches are stitched anonymously (by device or
              session), not by a known identifier.
            </p>
          ) : (
            <ul className="space-y-2">
              {trace.identity_evidence.map((ev, i) => (
                <li
                  key={`${ev.identifier_type}␟${ev.source}␟${i}`}
                  className="rounded-lg border border-border p-3"
                  data-testid={`identity-evidence-${i}`}
                >
                  <p className="text-sm font-medium text-foreground">{ev.identifier_type}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span>via {ev.source}</span>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3" aria-hidden="true" />
                      first seen {formatTs(ev.first_seen)}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 2. Customer timeline — newest-first event feed for one brain_id
 * ───────────────────────────────────────────────────────────────────────────── */

function CustomerTimelinePanel() {
  const [input, setInput] = useState('');
  const [brainId, setBrainId] = useState<string | null>(null);

  const timelineQ = useCustomerJourney(brainId);
  const timeline = timelineQ.data;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    setBrainId(trimmed.length > 0 ? trimmed : null);
  }

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <User className="size-4 text-muted-foreground" aria-hidden="true" />
          Customer timeline
        </span>
      }
      description="Enter a customer ID (brain_id) to see their full event feed, newest first."
    >
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2" role="search">
        <label htmlFor="timeline-brain-id" className="sr-only">
          Customer ID (brain_id)
        </label>
        <input
          id="timeline-brain-id"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Customer ID (brain_id, a UUID)"
          className="h-9 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="timeline-brain-input"
        />
        <Button type="submit" size="sm" disabled={input.trim().length === 0}>
          <Search className="size-4" aria-hidden="true" />
          View
        </Button>
      </form>

      <div className="mt-5">
        {brainId === null ? (
          <EmptyState
            compact
            icon={<User />}
            title="Open a customer's timeline"
            description="Enter a customer ID (brain_id) above to see every event we've recorded for them, most recent first."
          />
        ) : timelineQ.isLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading customer timeline…">
            <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            <div className="h-12 w-full animate-pulse rounded bg-muted" />
            <div className="h-12 w-full animate-pulse rounded bg-muted" />
            <div className="h-12 w-full animate-pulse rounded bg-muted" />
          </div>
        ) : timelineQ.isError ? (
          <ErrorCard error={timelineQ.error} retry={() => timelineQ.refetch()} />
        ) : !timeline || timeline.state === 'no_data' ? (
          <EmptyState
            compact
            icon={<User />}
            title="No timeline found"
            description={`We have no recorded events for customer "${brainId}". The ID may be wrong, or this customer is too new / unstitched to have a journey yet.`}
            hint="Check the brain_id, or try again after the next journey refresh."
          />
        ) : (
          <CustomerTimelineResult timeline={timeline} />
        )}
      </div>
    </SectionCard>
  );
}

/** The newest-first compact event feed for a single customer. */
function CustomerTimelineResult({ timeline }: { timeline: TimelineHasData }) {
  return (
    <div className="space-y-4">
      {/* Header row — brain_id, journey version, data source. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <User className="size-3.5" aria-hidden="true" />
          <span className="font-mono text-foreground">{timeline.brain_id}</span>
        </span>
        {timeline.journey_version != null && (
          <>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5">
              <GitBranch className="size-3" aria-hidden="true" />
              Journey v{timeline.journey_version}
            </span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <DataSourceBadge source={timeline.data_source} />
        <span aria-hidden="true">·</span>
        <span>{timeline.items.length} events</span>
      </div>

      {timeline.items.length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          No events recorded for this customer yet.
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {timeline.items.map((it, i) => {
            const e = eventLabel(it.type);
            return (
              <li
                key={`${it.session_id ?? 'nosession'}␟${i}`}
                className="flex items-start gap-3 p-3"
                data-testid={`timeline-item-${i}`}
              >
                <span
                  className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted/60 text-muted-foreground"
                  aria-hidden="true"
                >
                  <e.Icon className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{e.label}</p>
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="size-3" aria-hidden="true" />
                      {formatTs(it.ts)}
                    </span>
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    {it.channel && <span>{it.channel}</span>}
                    {it.campaign && (
                      <>
                        {it.channel && <span aria-hidden="true">·</span>}
                        <span>{it.campaign}</span>
                      </>
                    )}
                    {it.url_path && (
                      <span className="truncate font-mono text-muted-foreground/80">
                        {it.url_path}
                      </span>
                    )}
                    {it.journey_version != null && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-1.5 py-0.5">
                        <GitBranch className="size-2.5" aria-hidden="true" />v{it.journey_version}
                      </span>
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {timeline.next_cursor != null && (
        <p className="text-xs text-muted-foreground" role="status">
          Showing the most recent events. More history exists beyond this page.
        </p>
      )}
    </div>
  );
}
