'use client';

/**
 * JourneyLedger — the versioned journey LEDGER for ONE resolved customer (Customer 360
 * Journey sub-view). Renders the CURRENT (is_current=true) projection of the event-sourced
 * Gold ledger iceberg.brain_gold.journey_events via brain_serving.mv_journey_events_current —
 * the post-identity-merge canonical timeline, newest-first — through the BFF
 * (GET /v1/analytics/journey/events, I-ST01: the UI never queries Trino).
 *
 * Keyset pagination: each fetched page is its own <LedgerPage/> chunk keyed by its opaque
 * cursor; the LAST chunk exposes its next_cursor through a "Load older events" button that
 * appends the next chunk (pure composition — no accumulation effects, each page caches
 * independently in React Query).
 *
 * MONEY (I-S07): revenue_minor is a bigint minor-unit string + sibling currency_code —
 * formatted via formatMoneyDisplay (no /100, no float); present ONLY on composite
 * transaction rows (revenue truth is the connector order).
 *
 * A11y (mirrors TouchpointTimeline):
 *   - the ledger is an ordered list (<ol>) — reading order matches visual order.
 *   - composite/transaction is a text badge, never colour-only.
 *   - loading/empty states are announced.
 */

import { useState } from 'react';
import { BookOpenText, Receipt, Hash } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { useJourneyEvents } from '@/lib/hooks/use-analytics';
import { humanize } from '@/lib/format/humanize';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { JourneyLedgerEventRow } from '@/lib/api/types';
import type { CurrencyCode } from '@brain/money';

/** ISO/Trino timestamp → a stable, locale-aware short timestamp (pure display; no float math). */
function fmtTime(ts: string): string {
  // Trino serves 'YYYY-MM-DD HH:MM:SS[.fff][ UTC]' (verified live: '2026-07-01 21:10:00.725 UTC')
  // — strip the zone suffix and normalize the space so Date can parse it as UTC.
  const cleaned = ts.replace(/\s*UTC$/, '');
  const d = new Date(cleaned.includes('T') ? cleaned : `${cleaned.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('en-IN', {
    year: 'numeric',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function LedgerRow({ event }: { event: JourneyLedgerEventRow }) {
  return (
    <li
      className="flex items-start gap-3 border-b border-border/60 py-2.5 last:border-0"
      data-testid={`journey-ledger-event-${event.sequence_number}`}
    >
      {/* Ledger position — the resolved-timeline sequence number. */}
      <span
        className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums text-muted-foreground"
        title={`Ledger sequence ${event.sequence_number} · version ${event.data_version}`}
      >
        <Hash className="h-2.5 w-2.5" aria-hidden="true" />
        {event.sequence_number}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground">
            {event.event_type}
          </span>
          {event.event_category && (
            <span className="text-xs text-muted-foreground">{humanize(event.event_category)}</span>
          )}
          {event.is_composite && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Receipt className="h-2.5 w-2.5" aria-hidden="true" />
              Transaction
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">{fmtTime(event.occurred_at)}</p>
        {(event.channel || event.campaign) && (
          <p
            className="truncate text-xs text-muted-foreground/80"
            title={[event.channel, event.campaign].filter(Boolean).join(' / ')}
          >
            {[event.channel ? humanize(event.channel) : null, event.campaign]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      </div>

      {/* Money — ONLY on composite transaction rows (bigint minor + sibling currency; I-S07). */}
      {event.revenue_minor !== null && (
        <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
          {event.currency_code
            ? formatMoneyDisplay(event.revenue_minor, event.currency_code as CurrencyCode)
            : event.revenue_minor}
        </span>
      )}
    </li>
  );
}

/**
 * One fetched page of the ledger. The FIRST page owns the loading/empty/error surface; every
 * page renders its rows; the LAST page owns the "Load older events" continuation button.
 */
function LedgerPage({
  brainId,
  cursor,
  isFirst,
  isLast,
  onLoadMore,
}: {
  brainId: string;
  cursor: string | null;
  isFirst: boolean;
  isLast: boolean;
  onLoadMore: (nextCursor: string) => void;
}) {
  const { data, isLoading, error, refetch } = useJourneyEvents(brainId, cursor);

  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading journey ledger…">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        {isFirst && <Skeleton className="h-10 w-full" />}
      </div>
    );
  }

  if (error) {
    return <ErrorCard error={error} retry={refetch} />;
  }

  if (!data) return null;

  if (data.state === 'no_data') {
    // Continuation pages past the end are impossible (next_cursor was null) — only the
    // first page ever renders the honest empty state.
    if (!isFirst) return null;
    return (
      <Card data-testid="journey-ledger-empty">
        <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
          <BookOpenText className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium text-foreground">No ledger events for this customer yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            As this customer&apos;s journey events flow through the versioned Gold ledger
            (<span className="font-mono">journey_events</span>), their resolved timeline appears here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <ol className="ml-1">
        {data.events.map((e) => (
          <LedgerRow key={e.touchpoint_id} event={e} />
        ))}
      </ol>
      {isLast && data.next_cursor && (
        <div className="pt-3">
          <Button
            variant="outline"
            size="sm"
            data-testid="journey-ledger-load-more"
            onClick={() => onLoadMore(data.next_cursor as string)}
          >
            Load older events
          </Button>
        </div>
      )}
    </>
  );
}

export function JourneyLedger({ brainId }: { brainId: string }) {
  // The ordered list of page cursors fetched so far (null = the first page). Appending the
  // last page's next_cursor extends the ledger downward — pure composition, no effects.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);

  return (
    <div className="space-y-1" data-testid="journey-ledger-section">
      {cursors.map((cursor, i) => (
        <LedgerPage
          key={cursor ?? 'first'}
          brainId={brainId}
          cursor={cursor}
          isFirst={i === 0}
          isLast={i === cursors.length - 1}
          onLoadMore={(next) =>
            setCursors((prev) => (prev.includes(next) ? prev : [...prev, next]))
          }
        />
      ))}
    </div>
  );
}
