'use client';

/**
 * JourneyTimeline — a generic, story-style vertical timeline of customer events,
 * rendered entirely in plain language (icons + human labels from lib/event-labels;
 * raw event codes NEVER reach the DOM — plain-language rule 3).
 *
 * PRESENTATIONAL ONLY: callers fetch (through the BFF, I-ST01) and pass events in
 * display order; `onLoadOlder`/`hasMore` drive keyset continuation (mirrors
 * JourneyLedger's "Load older events" composition).
 *
 * MONEY (I-S07): `revenueMinor` is a bigint minor-unit string + sibling
 * `currencyCode` — formatted via formatMoneyDisplay (no /100, no float).
 *
 * TIME: `occurredAt` may be a Trino timestamp carrying a ' UTC' suffix
 * ('2026-07-01 21:10:00.725 UTC') — normalized before parsing. Relative time
 * ("2 minutes ago") is primary, absolute is beside it (plain-language rule 4);
 * an unparseable timestamp shows "Unknown time" — never a fabricated one.
 *
 * A11y:
 *   - ordered list (<ol>) — reading order matches visual order.
 *   - each event is icon + text label, never colour/icon-only.
 *   - the highlight ring is paired with a text badge ("This order"), never colour-only.
 *   - loading/empty states are announced; empty is honest (rule 1).
 */

import * as React from 'react';
import { Receipt, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { eventLabel } from '@/lib/event-labels';
import { relativeTime } from '@/lib/format/relative-time';
import { humanize } from '@/lib/format/humanize';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import { cn } from '@/lib/utils';
import type { CurrencyCode } from '@brain/money';

export interface JourneyTimelineEvent {
  /** Stable unique id for the row (React key). */
  id: string;
  /** ISO/Trino timestamp; may carry a trailing ' UTC' (stripped before parsing). */
  occurredAt: string;
  /** Internal event type (e.g. 'page.viewed', 'order.live.v1') — humanized before render. */
  eventType: string;
  /** Optional caller-provided context line; falls back to the event's plain-language description. */
  description?: string;
  /** Raw channel code (e.g. 'paid_meta') — humanized before render. */
  channel?: string;
  /** Bigint minor-unit amount as a string (transaction rows only). */
  revenueMinor?: string;
  /** ISO 4217 sibling of revenueMinor. */
  currencyCode?: string;
  /** Marks a composite transaction row (gets a "Transaction" badge). */
  isComposite?: boolean;
  /** Highlights this event with a subtle ring (e.g. the order being traced). */
  highlight?: boolean;
}

export interface JourneyTimelineProps {
  /** Events in display order (caller decides newest/oldest-first). */
  events: JourneyTimelineEvent[];
  /** Also highlights the event whose `id` equals this (convenience beside per-event `highlight`). */
  highlightOrderId?: string;
  /** Fetches the next (older) page — renders a "Show earlier events" button when `hasMore`. */
  onLoadOlder?: () => void;
  /** Whether older events exist beyond the current list. */
  hasMore?: boolean;
  /** Shows skeletons (initial load) or a loading continuation button state. */
  loading?: boolean;
  className?: string;
}

/** Normalize a Trino/ISO timestamp (strip ' UTC', 'YYYY-MM-DD hh:mm' → ISO-with-Z) for Date parsing. */
function normalizeTimestamp(ts: string): string {
  const cleaned = ts.replace(/\s*UTC$/, '').trim();
  return cleaned.includes('T') ? cleaned : `${cleaned.replace(' ', 'T')}Z`;
}

function TimelineRow({ event, highlighted }: { event: JourneyTimelineEvent; highlighted: boolean }) {
  const { label, Icon, description } = eventLabel(event.eventType);
  const time = relativeTime(normalizeTimestamp(event.occurredAt), Number.POSITIVE_INFINITY);
  const money =
    event.revenueMinor != null && event.currencyCode
      ? formatMoneyDisplay(event.revenueMinor, event.currencyCode as CurrencyCode)
      : null;

  return (
    <li className="relative pb-4 pl-10 last:pb-0" data-testid={`journey-timeline-event-${event.id}`}>
      {/* Connector line down to the next node (hidden on the last row via li padding trick). */}
      <span
        className="absolute left-[13px] top-8 h-[calc(100%-2rem)] w-px bg-border"
        aria-hidden="true"
      />
      {/* Timeline node — the event's icon. */}
      <span
        className="absolute left-0 top-1 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
        aria-hidden="true"
      >
        <Icon className="h-3.5 w-3.5" />
      </span>

      <div
        className={cn(
          'rounded-lg border border-border bg-card p-3',
          highlighted && 'ring-2 ring-ring/60',
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{label}</span>

          {event.isComposite && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Receipt className="h-2.5 w-2.5" aria-hidden="true" />
              Transaction
            </span>
          )}
          {highlighted && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
              This order
            </span>
          )}

          {money && (
            <span className="ml-auto shrink-0 text-sm font-medium tabular-nums text-foreground">
              {money}
            </span>
          )}
        </div>

        <p className="mt-0.5 text-xs text-muted-foreground">{event.description ?? description}</p>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground/80">
          {time.absolute ? (
            <>
              <span>{time.label}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{time.absolute}</span>
            </>
          ) : (
            <span>Unknown time</span>
          )}
          {event.channel && (
            <>
              <span aria-hidden="true">·</span>
              <span>{humanize(event.channel)}</span>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

export function JourneyTimeline({
  events,
  highlightOrderId,
  onLoadOlder,
  hasMore = false,
  loading = false,
  className,
}: JourneyTimelineProps) {
  // Initial load — skeleton rows, never a fake empty/zero state (rule 1).
  if (loading && events.length === 0) {
    return (
      <div
        className={cn('space-y-3', className)}
        aria-busy="true"
        aria-label="Loading journey timeline…"
        data-testid="journey-timeline-loading"
      >
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  // Honest empty state — no events is a real (and common) early state, never an error.
  if (events.length === 0) {
    return (
      <EmptyState
        className={className}
        compact
        title="No events yet"
        description="As this customer browses and buys, their story appears here — from first visit to purchase."
      />
    );
  }

  return (
    <div className={cn('space-y-3', className)} data-testid="journey-timeline">
      <ol className="max-h-[32rem] overflow-y-auto pr-1">
        {events.map((event) => (
          <TimelineRow
            key={event.id}
            event={event}
            highlighted={Boolean(event.highlight) || (highlightOrderId != null && event.id === highlightOrderId)}
          />
        ))}
      </ol>

      {hasMore && onLoadOlder && (
        <Button
          variant="outline"
          size="sm"
          onClick={onLoadOlder}
          disabled={loading}
          data-testid="journey-timeline-load-older"
        >
          {loading ? 'Loading…' : 'Show earlier events'}
        </Button>
      )}
    </div>
  );
}
