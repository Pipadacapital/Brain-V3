'use client';

import * as React from 'react';
import { FreshnessIndicator } from '@/components/ui/freshness-indicator';
import { relativeTime } from '@/lib/format/relative-time';

/**
 * FreshnessBadge — the one-prop freshness surface for a data widget.
 *
 * Pass the raw endpoint timestamp (generated_at / served_at / as_of / last_refresh).
 * This wraps the new relative-time helper + the FreshnessIndicator primitive so callers
 * never format time themselves.
 *
 * Honesty rule (Brain): when `timestamp` is null/undefined/missing we DON'T fabricate a
 * "just now" — and we no longer render the awkward "Updated an unknown time ago" placeholder
 * either. Only ~10 BFF endpoints expose a timestamp today; for the rest we render NOTHING
 * (omit the badge) rather than claim a freshness we don't have. Pass `showUnknown` to opt back
 * into an explicit "freshness unknown" pill where a widget specifically wants to signal it.
 *
 * Place on every widget: SectionCard.meta, MetricCard.freshness, or inline under a value.
 */
export interface FreshnessBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Raw ISO timestamp from the endpoint, or null/undefined when none is exposed. */
  timestamp?: string | null;
  /** Override the prefix word. Default "Updated". */
  prefix?: string;
  /** Age (ms) beyond which the tone becomes 'stale'. Default 1h. */
  staleAfterMs?: number;
  /** When true, render an explicit "freshness unknown" pill instead of omitting the badge. */
  showUnknown?: boolean;
}

export function FreshnessBadge({
  timestamp,
  prefix = 'Updated',
  staleAfterMs,
  showUnknown = false,
  ...props
}: FreshnessBadgeProps) {
  const { label, tone, absolute } = relativeTime(timestamp, staleAfterMs);
  // No real timestamp → omit the badge entirely (honest: no claim) instead of the awkward
  // "Updated an unknown time ago". Opt in via showUnknown where an explicit signal is wanted.
  if (tone === 'unknown' && !showUnknown) return null;
  return (
    <FreshnessIndicator
      label={tone === 'unknown' ? 'freshness unknown' : label}
      tone={tone}
      prefix={tone === 'unknown' ? '' : prefix}
      title={absolute ?? undefined}
      {...props}
    />
  );
}
