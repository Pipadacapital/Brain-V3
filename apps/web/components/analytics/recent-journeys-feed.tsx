'use client';

/**
 * RecentJourneysFeed — a browsable list of COMPLETE customer journeys in plain language.
 *
 * Answers "show me the journeys we're creating" for a non-technical reader: one card per visitor
 * (newest activity first), read like a sentence — where they first arrived, how much they explored,
 * and whether they bought. Data: the per-visitor rollup mv_gold_journey via useJourneyList (first/last
 * channel, touchpoint/session counts, converted?, days_to_convert). Click a card to expand the full
 * step-by-step story (the shared JourneyLedger → JourneyTimeline, every event humanized).
 *
 * No raw codes/hashes on the DOM: channels render via channelMeta (icon + friendly label); the visitor
 * is a short opaque tag, never a hash dump. Honest-empty when there are no journeys yet.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, ShoppingBag, Eye, ArrowRight, MoveRight, Route } from 'lucide-react';
import { SectionCard } from '@/components/ui/section-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { Button } from '@/components/ui/button';
import { channelMeta } from '@/components/analytics/channel-meta';
import { JourneyLedger } from '@/components/analytics/journey-ledger';
import { relativeTime } from '@/lib/format/relative-time';
import { useJourneyList } from '@/lib/hooks/use-analytics';
import type { JourneyListRow } from '@/lib/api/types';

/** A short, friendly, non-PII visitor tag from the opaque anon key (e.g. "Visitor a1b2"). */
function visitorTag(anon: string): string {
  const clean = anon.replace(/[^a-zA-Z0-9]/g, '');
  return `Visitor ${clean.slice(-4) || clean.slice(0, 4) || '—'}`;
}

function num(s: string | null): number {
  const n = Number(s ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** One channel bookend chip (icon + friendly label). */
function ChannelChip({ channel }: { channel: string }) {
  const meta = channelMeta(channel);
  const Icon = meta.icon;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function OutcomeBadge({ row }: { row: JourneyListRow }) {
  if (row.converted) {
    const days = num(row.days_to_convert);
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-0.5 text-xs font-semibold text-success">
        <ShoppingBag className="size-3.5" aria-hidden="true" />
        Bought
        {row.days_to_convert != null && (
          <span className="font-normal opacity-80">· {days === 0 ? 'same day' : `${days}d to decide`}</span>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      <Eye className="size-3.5" aria-hidden="true" />
      Still browsing
    </span>
  );
}

function JourneyCard({ row }: { row: JourneyListRow }) {
  const [open, setOpen] = useState(false);
  const steps = num(row.touchpoint_count);
  const channels = num(row.distinct_channels);
  const sessions = num(row.distinct_sessions);
  const sameChannel = row.first_channel === row.last_channel;

  return (
    <li className="rounded-lg border border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          {/* Line 1: who + outcome */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-foreground">{visitorTag(row.brain_anon_id)}</span>
            <OutcomeBadge row={row} />
          </div>

          {/* Line 2: the journey — first channel → (middle) → last channel */}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-muted-foreground">
            <ChannelChip channel={row.first_channel} />
            {!sameChannel && (
              <>
                <MoveRight className="size-3.5 shrink-0" aria-hidden="true" />
                <ChannelChip channel={row.last_channel} />
              </>
            )}
            <span className="text-xs">
              {sameChannel ? '· ' : '· '}
              {steps} step{steps === 1 ? '' : 's'}
              {channels > 1 ? ` across ${channels} channels` : ''}
              {sessions > 1 ? ` · ${sessions} visits` : ''}
            </span>
          </div>

          {/* Line 3: timing, plain-language */}
          <div className="mt-1.5 text-xs text-muted-foreground/80">
            Arrived {relativeTime(row.first_touch_at).label}
            {row.last_touch_at !== row.first_touch_at && <> · last seen {relativeTime(row.last_touch_at).label}</>}
            {row.converted && row.converted_at && <> · bought {relativeTime(row.converted_at).label}</>}
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-border p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Full journey — every step
          </div>
          {/* Unstitched visitors carry brain_id = 'anonymous_<anon>' in the ledger; stitched ones
              resolve to their customer. Try the anonymous key — honest-empty if the ledger has none. */}
          <JourneyLedger brainId={`anonymous_${row.brain_anon_id}`} />
        </div>
      )}
    </li>
  );
}

export function RecentJourneysFeed() {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  // Only the LAST cursor drives the fetch; earlier pages stay rendered from cache via the hook key.
  const cursor = cursors[cursors.length - 1] ?? null;
  const { data, isLoading, error, refetch } = useJourneyList({ limit: 20, cursor });

  const hasData = data?.state === 'has_data';
  const rows: JourneyListRow[] = hasData ? data.rows : [];
  const nextCursor = hasData ? data.next_cursor : null;

  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          <Route className="size-4 text-primary" aria-hidden="true" />
          Recent journeys
        </span>
      }
      description="Every visitor's path from first arrival to purchase — click any to read the full story."
    >
      <div aria-live="polite" aria-busy={isLoading}>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : error ? (
          <ErrorCard error={error} retry={refetch} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Route className="h-6 w-6" aria-hidden="true" />}
            title="No journeys yet"
            description="As visitors browse and buy, each person's complete path — where they arrived, what they explored, and whether they converted — appears here."
          />
        ) : (
          <>
            <ul className="space-y-2" role="list">
              {rows.map((row) => (
                <JourneyCard key={row.brain_anon_id} row={row} />
              ))}
            </ul>
            {nextCursor && (
              <div className="mt-3 flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setCursors((prev) => (nextCursor && !prev.includes(nextCursor) ? [...prev, nextCursor] : prev))
                  }
                >
                  Show more journeys <ArrowRight className="ml-1.5 size-3.5" aria-hidden="true" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}
