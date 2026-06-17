'use client';

/**
 * EventExplorer — recent collected events feed (Phase 1b), so a non-technical
 * stakeholder can watch data arrive: event type, time, ANONYMIZED ids only.
 *
 * PII: the BFF returns only type/time + anonymized ids (brain_anon_id /
 * hashed_session_id). This component truncates those ids further for display and
 * NEVER renders any raw identifier.
 *
 * A11y:
 *   - list with role="list" + aria-label; each row carries an aria-label with full context.
 *   - event types distinguished by icon + text label, never colour alone.
 *   - consent shown as text ("consent" / "no consent"), not colour-only.
 *   - honest empty / loading / error states.
 */

import * as React from 'react';
import { Eye, ShoppingCart, PackagePlus, Activity, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorCard } from '@/components/ui/error-card';
import { useRecentEvents } from '@/lib/hooks/use-tracking-health';
import { formatRelativeTime } from '@/components/analytics/data-health-relative-time';
import type { AnalyticsRecentEventRow } from '@/lib/api/types';
import { cn } from '@/lib/utils';

const EVENT_CONFIG: Record<
  string,
  { label: string; icon: React.ElementType; iconClass: string; bgClass: string }
> = {
  'page.viewed': { label: 'Page viewed', icon: Eye, iconClass: 'text-status-green-700', bgClass: 'bg-status-green-50' },
  'cart.viewed': { label: 'Cart viewed', icon: ShoppingCart, iconClass: 'text-status-amber-700', bgClass: 'bg-status-amber-50' },
  'cart.item_added': { label: 'Item added to cart', icon: PackagePlus, iconClass: 'text-status-amber-700', bgClass: 'bg-status-amber-50' },
};

function configFor(eventType: string) {
  return (
    EVENT_CONFIG[eventType] ?? {
      label: eventType,
      icon: Activity,
      iconClass: 'text-muted-foreground',
      bgClass: 'bg-muted/50',
    }
  );
}

/** Truncate an anonymized id for display (it is not PII, but keep it compact). */
function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function EventRow({ row }: { row: AnalyticsRecentEventRow }) {
  const cfg = configFor(row.event_type);
  const Icon = cfg.icon;
  const relTime = formatRelativeTime(row.occurred_at);
  const anon = shortId(row.anon_id);
  const consentLabel = row.has_consent ? 'consent' : 'no consent';

  return (
    <li
      className="flex items-start gap-3 py-2"
      aria-label={`${cfg.label} — ${relTime}, anonymous id ${anon}, ${consentLabel}`}
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          cfg.bgClass,
          cfg.iconClass,
        )}
        aria-hidden="true"
        title={cfg.label}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-foreground truncate">{cfg.label}</p>
          <time
            className="text-xs text-muted-foreground shrink-0"
            dateTime={row.occurred_at}
          >
            {relTime}
          </time>
        </div>
        <p className="text-xs text-muted-foreground font-mono truncate">
          <span aria-hidden="true">anon: {anon}</span>
          {' · '}
          <span className={row.has_consent ? 'text-status-green-700' : 'text-muted-foreground'}>
            {row.has_consent ? '✓ consent' : 'no consent'}
          </span>
        </p>
      </div>
    </li>
  );
}

export function EventExplorer() {
  const { data, isLoading, error, refetch, isFetching } = useRecentEvents(20);

  return (
    <Card data-testid="event-explorer">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Event Explorer
          {isFetching && (
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
          )}
        </CardTitle>
        <CardDescription>
          Recent collected events (type, time, anonymized ids). Updates live. No raw
          personal data is shown.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Event Explorer — loading">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <ErrorCard error={error} retry={refetch} />
        ) : (data?.rows.length ?? 0) === 0 ? (
          <EmptyState
            title="No events yet"
            description="Collected events will appear here as visitors browse your site."
            icon={<Activity className="h-8 w-8" />}
          />
        ) : (
          <ul role="list" aria-label="Recent collected events" className="divide-y divide-border">
            {data!.rows.map((row) => (
              <EventRow key={row.event_id} row={row} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
