'use client';

/**
 * EventExplorer — recent PIXEL events table, so a non-technical stakeholder can watch data
 * arrive through their pixel: relative time, HUMAN event name (via eventLabel — the raw
 * internal code is never rendered as a label), and the page/product when captured.
 *
 * PIXEL-ONLY: the BFF returns ONLY events received through the pixel (browser events via
 * /collect). Server-trusted connector events (orders, spend, logistics) are NEVER shown here.
 *
 * PII: the BFF returns only type/time + anonymized ids and a PII-redacted `details` map.
 * Raw values appear only inside the collapsed "Technical details" JSON per row.
 *
 * A11y: semantic <table>; event types distinguished by icon + text label, never colour
 * alone; the expand toggle is a real button with aria-expanded; honest empty state.
 */

import * as React from 'react';
import { Activity, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { SectionCard } from '@/components/ui/section-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorCard } from '@/components/ui/error-card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { useRecentEvents } from '@/lib/hooks/use-tracking-health';
import { formatRelativeTime } from '@/components/analytics/data-health-relative-time';
import { eventLabel } from '@/lib/event-labels';
import type { AnalyticsRecentEventRow } from '@/lib/api/types';

/** Max rows shown (the BFF caps at 50 server-side). */
const MAX_EVENTS = 50;

/**
 * Pull the page or product context out of the PII-safe details map, when the event
 * captured one. Keys mirror the pixel's flattened properties (path/url/product…).
 * Honest: returns null when nothing was captured — the cell renders "—".
 */
function pageOrProduct(details: Record<string, string>): string | null {
  return (
    details['product_name'] ??
    details['product.name'] ??
    details['name'] ??
    details['product_id'] ??
    details['product.id'] ??
    details['path'] ??
    details['page.path'] ??
    details['page_path'] ??
    details['url'] ??
    details['page.url'] ??
    null
  );
}

function EventRow({ row }: { row: AnalyticsRecentEventRow }) {
  const [expanded, setExpanded] = React.useState(false);
  const { label, Icon } = eventLabel(row.event_type);
  const relTime = formatRelativeTime(row.occurred_at);
  const context = pageOrProduct(row.details ?? {});
  const detailsId = `event-technical-${row.event_id}`;

  // The full raw record — shown ONLY inside the collapsed "Technical details" drawer.
  const technical = JSON.stringify(
    {
      event_id: row.event_id,
      event_type: row.event_type,
      occurred_at: row.occurred_at,
      anon_id: row.anon_id,
      session_id: row.session_id,
      has_consent: row.has_consent,
      details: row.details,
    },
    null,
    2,
  );

  return (
    <>
      <TableRow data-testid={`event-row-${row.event_id}`}>
        <TableCell className="whitespace-nowrap text-muted-foreground">
          <time dateTime={row.occurred_at}>{relTime}</time>
        </TableCell>
        <TableCell>
          <span className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium text-foreground">{label}</span>
          </span>
        </TableCell>
        <TableCell className="max-w-[16rem]">
          {context ? (
            <span className="block truncate text-muted-foreground" title={context}>
              {context}
            </span>
          ) : (
            <span className="text-muted-foreground/50">—</span>
          )}
        </TableCell>
        <TableCell>
          <StatusBadge tone={row.has_consent ? 'success' : 'neutral'} hideDot={!row.has_consent}>
            {row.has_consent ? 'Consented' : 'No consent'}
          </StatusBadge>
        </TableCell>
        <TableCell className="text-right">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={detailsId}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Technical details
          </button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-muted/40" id={detailsId}>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md p-2 font-mono text-xs text-muted-foreground">
              {technical}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function EventExplorer() {
  const { data, isLoading, error, refetch, isFetching } = useRecentEvents(MAX_EVENTS);
  const [typeFilter, setTypeFilter] = React.useState<string>('all');

  const rows = React.useMemo(() => data?.rows ?? [], [data]);

  // Distinct event types present in the feed → human-named filter options.
  const typeOptions = React.useMemo(() => {
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];
    for (const row of rows) {
      if (seen.has(row.event_type)) continue;
      seen.add(row.event_type);
      options.push({ value: row.event_type, label: eventLabel(row.event_type).label });
    }
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }, [rows]);

  const visibleRows =
    typeFilter === 'all' ? rows : rows.filter((row) => row.event_type === typeFilter);

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <Activity className="size-4 text-muted-foreground" aria-hidden="true" />
          Recent events
          {isFetching && (
            <RefreshCw className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
          )}
        </span>
      }
      description="Events received through your pixel, newest first. Updates live. Connector data (orders, ad spend) is not shown here, and no raw personal data is ever shown."
      actions={
        typeOptions.length > 0 ? (
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-9 w-52" aria-label="Filter by event type">
              <SelectValue placeholder="All event types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All event types</SelectItem>
              {typeOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : undefined
      }
      flush
      data-testid="event-explorer"
    >
      {isLoading ? (
        <div className="space-y-3 p-5" aria-busy="true" aria-label="Recent events — loading">
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
        <div className="p-5">
          <ErrorCard error={error} retry={refetch} />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-5">
          <EmptyState
            title="No pixel events yet"
            description="Events will appear here as visitors browse your site with the pixel installed."
            icon={<Activity />}
            compact
          />
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="p-5">
          <EmptyState
            title="No events of this type"
            description="No recent event matches this filter — try another event type."
            icon={<Activity />}
            compact
          />
        </div>
      ) : (
        <Table aria-label="Recent pixel events">
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Page / product</TableHead>
              <TableHead>Consent</TableHead>
              <TableHead>
                <span className="sr-only">Technical details</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.map((row) => (
              <EventRow key={row.event_id} row={row} />
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
