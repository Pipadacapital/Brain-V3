'use client';

/**
 * TimeframeBadge — states, in one glance, the time window a metric is computed over.
 *
 * Brain rule: confidence + freshness measurable. A number a brand can't date is a number it can't
 * trust — so every headline metric carries the period it reflects. Today the marts are cumulative
 * (all-time), so we render "All-time · <first> – <last>" where the dates are the data-coverage span
 * (earliest/latest event). When Phase-2 adds an interactive window, pass mode="range" + a label.
 *
 * Honest: if the coverage span is unknown (null), we still state the mode ("All-time") rather than
 * fabricate a range. Renders nothing only when there is genuinely nothing to say.
 */

import * as React from 'react';
import { CalendarRange } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TimeframeBadgeProps {
  /** Coverage window start (ISO date/datetime string), if known. */
  start?: string | null;
  /** Coverage window end (ISO date/datetime string), if known. */
  end?: string | null;
  /** 'all-time' = cumulative marts (default); 'range' = an explicit selected window. */
  mode?: 'all-time' | 'range';
  /** Override the leading label (e.g. "Last 30 days"). Defaults from mode. */
  label?: string;
  className?: string;
  'data-testid'?: string;
}

function fmtDate(iso: string): string | null {
  // Accept "2026-05-26" or "2026-05-26 04:52:37.000000 UTC" or full ISO — take the date head.
  const datePart = iso.trim().split(/[ T]/)[0];
  if (!datePart) return null;
  const d = new Date(`${datePart}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function TimeframeBadge({
  start,
  end,
  mode = 'all-time',
  label,
  className,
  'data-testid': testId,
}: TimeframeBadgeProps) {
  const lead = label ?? (mode === 'all-time' ? 'All-time' : 'Custom range');
  const from = start ? fmtDate(start) : null;
  const to = end ? fmtDate(end) : null;

  const range = from && to ? (from === to ? from : `${from} – ${to}`) : null;
  const text = range ? `${lead} · ${range}` : lead;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground',
        className,
      )}
      title={range ? `${lead}: ${range}` : lead}
      data-testid={testId}
    >
      <CalendarRange className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {text}
    </span>
  );
}
