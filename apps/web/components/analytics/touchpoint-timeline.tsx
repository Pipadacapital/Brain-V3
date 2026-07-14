'use client';

/**
 * TouchpointTimeline — the ordered touchpoint timeline for a SELECTED order
 * (Silver-tier journey). Resolves an order → its deterministically-stitched anon
 * journey → the ordered touches (touch_seq asc) from silver.touchpoint via the
 * metric-engine journey seam (I-ST01 — the UI never queries the serving tier).
 *
 * PLAIN LANGUAGE: rows render through the shared <JourneyTimeline/> — internal event
 * codes are humanized via lib/event-labels (icon + "Page view"-style label + a
 * story-style sentence composed from the touch's UTM/referrer context and first/last
 * flags); raw codes never reach the DOM. Relative + absolute time per row.
 *
 * It is a read PROJECTION (no aggregation, no money) — an order with no stitched
 * journey shows an honest empty state (never a fabricated touch).
 *
 * CONTROLLED MODE: pass `orderId` to drive the trace externally (the Customer Profile
 * "Explain this order" box); the internal input is hidden. Without the prop it stays
 * self-contained (the Journeys page usage is unchanged).
 */

import { useState } from 'react';
import { Link2, Route } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { JourneyTimeline, type JourneyTimelineEvent } from '@/components/analytics/journey-timeline';
import { eventLabel } from '@/lib/event-labels';
import { useJourneyTimeline } from '@/lib/hooks/use-analytics';
import type { JourneyTouchpointRow } from '@/lib/api/types';

/**
 * Compose the story-style sentence for one touch: the event's plain-language meaning,
 * prefixed with its first/last-touch role and suffixed with where the shopper came
 * from (UTM triple, else referrer, else landing path). Never the raw code.
 */
function touchDescription(t: JourneyTouchpointRow): string {
  const { description } = eventLabel(t.event_type);
  const utmBits = [t.utm_source, t.utm_medium, t.utm_campaign]
    .filter((v): v is string => Boolean(v))
    .join(' / ');
  const context = utmBits || t.referrer_host || t.landing_path || null;

  const parts: string[] = [];
  if (t.is_first_touch) parts.push('First touch —');
  else if (t.is_last_touch) parts.push('Last touch —');
  parts.push(description);
  if (context) parts.push(`Came via ${context}.`);
  return parts.join(' ');
}

function toTimelineEvent(t: JourneyTouchpointRow): JourneyTimelineEvent {
  return {
    id: String(t.touch_seq),
    occurredAt: t.occurred_at,
    eventType: t.event_type,
    description: touchDescription(t),
    channel: t.channel,
  };
}

export function TouchpointTimeline({
  orderId: controlledOrderId,
}: {
  /** Controlled mode: the order to trace (null = none yet). Omit for the self-contained input. */
  orderId?: string | null;
} = {}) {
  const isControlled = controlledOrderId !== undefined;
  const [draft, setDraft] = useState('');
  const [internalOrderId, setInternalOrderId] = useState<string | null>(null);
  const orderId = isControlled ? controlledOrderId : internalOrderId;

  const { data, isLoading, error, refetch } = useJourneyTimeline(orderId);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    setInternalOrderId(v.length > 0 ? v : null);
  };

  const hasData = data?.state === 'has_data';

  return (
    <div className="space-y-3" data-testid="journey-timeline-section">
      {!isControlled && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="journey-order-id" className="text-xs font-medium text-muted-foreground">
              Order ID
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
      )}

      {orderId === null && !isControlled && (
        <Card data-testid="journey-timeline-prompt">
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <Route className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground max-w-md">
              Enter an order ID to trace its journey — the ordered steps that led to that
              order, from first visit to purchase.
            </p>
          </CardContent>
        </Card>
      )}

      {orderId != null && isLoading && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading journey timeline…">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}

      {orderId != null && !isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {orderId != null && !isLoading && !error && data?.state === 'no_data' && (
        <Card data-testid="journey-timeline-empty">
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <Link2 className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">No traced journey for this order</p>
            <p className="text-sm text-muted-foreground max-w-md">
              We could not reliably link order <span className="font-mono">{orderId}</span> to a
              browsing session. Linking only happens when the order itself carries the visitor
              reference at checkout — it is never guessed.
            </p>
          </CardContent>
        </Card>
      )}

      {orderId != null && !isLoading && !error && hasData && (
        <Card data-testid="journey-timeline-result">
          <CardContent className="py-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                Journey for order <span className="font-mono">{orderId}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                · {data.touches.length} step{data.touches.length === 1 ? '' : 's'}
              </span>
              {data.data_source === 'synthetic' && (
                <SyntheticBadge
                  data-testid="journey-timeline-synthetic-badge"
                  reason="This journey is built from clearly-labelled sample steps so the timeline is demoable — real browsing coverage is thin in this environment."
                />
              )}
            </div>

            {data.touches.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                Linked to a session, but no browsing steps were recorded for this journey.
              </p>
            ) : (
              <JourneyTimeline
                events={[...data.touches]
                  .sort((a, b) => a.touch_seq - b.touch_seq)
                  .map(toTimelineEvent)}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
