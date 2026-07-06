import * as React from 'react';
import { Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * DataWindowBadge — states, in plain English, WHICH window of data a surface is showing:
 * "Showing Jan 1, 2026 → Feb 1, 2026 · 342 records". This is the honest-empty companion to a
 * table/list: instead of an unexplained set of rows, the reader always sees the exact date
 * span (and optional record count) the numbers cover.
 *
 * Null/unknown dates render "all time" rather than a fabricated boundary — we never invent a
 * date we don't have.
 *
 * Zero-dep: dates are formatted with Intl.DateTimeFormat (en-IN, "Mon D, YYYY"); no date-fns.
 * A11y: the full phrase is set as aria-label so screen readers get one coherent sentence, and
 * the Calendar icon is aria-hidden. Meaning is text+icon, never colour.
 */
export interface DataWindowBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Inclusive window start (ISO date/timestamp), or null/undefined when unbounded. */
  from: string | null | undefined;
  /** Inclusive window end (ISO date/timestamp), or null/undefined when unbounded. */
  to: string | null | undefined;
  /** Optional record count shown as "· {count} {label}". */
  count?: number;
  /** Noun for the count. Default "records". */
  label?: string;
}

const DATE_FMT = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Format an ISO date/timestamp as "Mon D, YYYY"; null/unparseable → null. */
function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  return DATE_FMT.format(new Date(ts));
}

export function DataWindowBadge({
  from,
  to,
  count,
  label = 'records',
  className,
  ...props
}: DataWindowBadgeProps) {
  const fromLabel = formatDate(from);
  const toLabel = formatDate(to);

  const windowText =
    fromLabel || toLabel ? `Showing ${fromLabel ?? 'all time'} → ${toLabel ?? 'all time'}` : 'Showing all time';

  const hasCount = typeof count === 'number' && Number.isFinite(count);
  const countText = hasCount ? `${count.toLocaleString('en-IN')} ${label}` : null;
  const phrase = countText ? `${windowText} · ${countText}` : windowText;

  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', className)}
      aria-label={phrase}
      {...props}
    >
      <Calendar className="size-3.5" aria-hidden="true" />
      <span>
        {windowText}
        {countText && (
          <>
            {' · '}
            {countText}
          </>
        )}
      </span>
    </span>
  );
}
