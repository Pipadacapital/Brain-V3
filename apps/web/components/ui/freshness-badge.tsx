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
 * Honesty rule (Brain): when `timestamp` is null/undefined/missing, this renders
 * tone='unknown' ("Updated an unknown time ago") — never a fabricated "just now".
 * Only ~10 BFF endpoints expose a timestamp; the rest legitimately show 'unknown'.
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
}

export function FreshnessBadge({
  timestamp,
  prefix = 'Updated',
  staleAfterMs,
  ...props
}: FreshnessBadgeProps) {
  const { label, tone, absolute } = relativeTime(timestamp, staleAfterMs);
  return (
    <FreshnessIndicator
      label={label}
      tone={tone}
      prefix={prefix}
      title={absolute ?? undefined}
      {...props}
    />
  );
}
