'use client';

/**
 * EventExplorer — recent collected-events feed, so a non-technical stakeholder can
 * watch data arrive: event type, time, ANONYMIZED ids only.
 *
 * PII: the BFF returns only type/time + anonymized ids (brain_anon_id /
 * hashed_session_id). This component truncates those further and NEVER renders a raw
 * identifier.
 *
 * A11y: list with role="list"; event types distinguished by icon + text label, never
 * colour alone; consent shown as a labelled StatusBadge; honest empty/loading/error.
 */

import * as React from 'react';
import { Eye, ShoppingCart, PackagePlus, Activity, RefreshCw } from 'lucide-react';
import { SectionCard } from '@/components/ui/section-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorCard } from '@/components/ui/error-card';
import { useRecentEvents } from '@/lib/hooks/use-tracking-health';
import { formatRelativeTime } from '@/components/analytics/data-health-relative-time';
import type { AnalyticsRecentEventRow } from '@/lib/api/types';

const EVENT_CONFIG: Record<string, { label: string; icon: React.ElementType }> = {
  'page.viewed': { label: 'Page viewed', icon: Eye },
  'cart.viewed': { label: 'Cart viewed', icon: ShoppingCart },
  'cart.item_added': { label: 'Item added to cart', icon: PackagePlus },
};

function configFor(eventType: string) {
  return EVENT_CONFIG[eventType] ?? { label: eventType, icon: Activity };
}

/** Truncate an anonymized id for display (not PII, but keep it compact). */
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
      className="flex items-start gap-3 py-3"
      aria-label={`${cfg.label} — ${relTime}, anonymous id ${anon}, ${consentLabel}`}
    >
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
        aria-hidden="true"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-medium text-foreground">{cfg.label}</p>
          <time className="shrink-0 text-xs tabular-nums text-muted-foreground" dateTime={row.occurred_at}>
            {relTime}
          </time>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground">anon: {anon}</span>
          <StatusBadge tone={row.has_consent ? 'success' : 'neutral'} hideDot={!row.has_consent}>
            {consentLabel}
          </StatusBadge>
        </div>
      </div>
    </li>
  );
}

export function EventExplorer() {
  const { data, isLoading, error, refetch, isFetching } = useRecentEvents(20);

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <Activity className="size-4 text-muted-foreground" aria-hidden="true" />
          Event explorer
          {isFetching && (
            <RefreshCw className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
          )}
        </span>
      }
      description="Recent collected events (type, time, anonymized ids). Updates live. No raw personal data is shown."
      data-testid="event-explorer"
    >
      {isLoading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Event explorer — loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
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
          icon={<Activity />}
          compact
        />
      ) : (
        <ul role="list" aria-label="Recent collected events" className="divide-y divide-border">
          {data!.rows.map((row) => (
            <EventRow key={row.event_id} row={row} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
