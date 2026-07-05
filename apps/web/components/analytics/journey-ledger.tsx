'use client';

/**
 * JourneyLedger — the versioned journey LEDGER for ONE resolved customer (Customer 360
 * Journey sub-view). Renders the CURRENT (is_current=true) projection of the event-sourced
 * Gold ledger iceberg.brain_gold.journey_events via brain_serving.mv_journey_events_current —
 * the post-identity-merge canonical timeline, newest-first — through the BFF
 * (GET /v1/analytics/journey/events, I-ST01: the UI never queries Trino).
 *
 * PLAIN LANGUAGE: the list itself is the shared <JourneyTimeline/> — every internal event
 * code is humanized via lib/event-labels (icon + "Page view"-style label + one-sentence
 * description); raw codes never reach the DOM. Relative + absolute timestamps per row.
 *
 * Keyset pagination: page cursors accumulate in state and fetch via useQueries (same
 * queryKey shape as useJourneyEvents, so pages cache independently and stay shared with
 * the hook's cache). The flattened rows feed ONE timeline; its "Show earlier events"
 * button appends the last page's next_cursor.
 *
 * MONEY (I-S07): revenue_minor is a bigint minor-unit string + sibling currency_code —
 * formatted inside JourneyTimeline via formatMoneyDisplay (no /100, no float); present
 * ONLY on composite transaction rows (revenue truth is the connector order).
 */

import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ErrorCard } from '@/components/ui/error-card';
import { JourneyTimeline, type JourneyTimelineEvent } from '@/components/analytics/journey-timeline';
import { analyticsApi } from '@/lib/api/client';
import { ANALYTICS_QUERY_KEY } from '@/lib/hooks/use-analytics';
import type { JourneyLedgerEventRow } from '@/lib/api/types';

/** One ledger row → the shared timeline's presentational shape (raw codes humanized inside). */
function toTimelineEvent(e: JourneyLedgerEventRow): JourneyTimelineEvent {
  return {
    id: e.touchpoint_id,
    occurredAt: e.occurred_at,
    eventType: e.event_type,
    channel: e.channel ?? undefined,
    revenueMinor: e.revenue_minor ?? undefined,
    currencyCode: e.currency_code ?? undefined,
    isComposite: e.is_composite,
  };
}

export function JourneyLedger({
  brainId,
  highlightOrderId,
}: {
  brainId: string;
  /**
   * Highlights the loaded event whose id matches (the "Explain this order" trace seam).
   * NOTE: the ledger endpoint does not expose composite_order_key today, so ids are
   * touchpoint hashes — callers should also offer the per-order trace as the fallback.
   */
  highlightOrderId?: string;
}) {
  // The ordered list of page cursors fetched so far (null = the first page). Appending the
  // last page's next_cursor extends the ledger downward — pure composition, no effects.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);

  const pages = useQueries({
    queries: cursors.map((cursor) => ({
      // Mirrors useJourneyEvents' queryKey exactly so each page shares the hook's cache.
      queryKey: [...ANALYTICS_QUERY_KEY, 'journey-events', brainId, cursor ?? null],
      queryFn: () => analyticsApi.getJourneyEvents({ brainId, cursor: cursor ?? null }),
      enabled: brainId.trim().length > 0,
      staleTime: 5 * 60_000,
    })),
  });

  const firstPage = pages[0];
  const lastPage = pages[pages.length - 1];

  // First-page hard failure owns the error surface (continuation errors retry via the button).
  if (firstPage?.error) {
    return <ErrorCard error={firstPage.error} retry={firstPage.refetch} />;
  }

  const events: JourneyTimelineEvent[] = pages.flatMap((p) =>
    p.data?.state === 'has_data' ? p.data.events.map(toTimelineEvent) : [],
  );

  const nextCursor = lastPage?.data?.state === 'has_data' ? lastPage.data.next_cursor : null;
  const loading = pages.some((p) => p.isLoading);

  return (
    <div data-testid="journey-ledger-section">
      <JourneyTimeline
        events={events}
        highlightOrderId={highlightOrderId}
        loading={loading}
        hasMore={Boolean(nextCursor)}
        onLoadOlder={() =>
          setCursors((prev) =>
            nextCursor && !prev.includes(nextCursor) ? [...prev, nextCursor] : prev,
          )
        }
      />
    </div>
  );
}
