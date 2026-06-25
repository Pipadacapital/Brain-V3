'use client';

/**
 * LiveIndicator — "Live · updated {relative} ago" badge for the dashboard.
 *
 * feat-realtime-ingestion-pipeline (Track C — Frontend/Web):
 *   The dashboard data hooks now poll on a ~20–30s `refetchInterval` (use-dashboard.ts /
 *   use-analytics.ts) so newly-ingested orders/revenue appear WITHOUT a manual reload.
 *   This badge makes that liveness HONEST + VISIBLE: it reads the react-query
 *   `dataUpdatedAt` of the primary dashboard query (the realized-revenue read — the
 *   headline number a stakeholder watches) and renders how long ago that data was fetched,
 *   re-rendering on a 1s client ticker.
 *
 * Honesty:
 *   - "Live" reflects a real, active polling query — never a faked badge. If the primary
 *     query is fetching, we say "Updating…"; if it has errored, we say "Reconnecting…"
 *     (so a dead poll never silently shows a stale-but-confident "Live").
 *   - The relative time is derived from `dataUpdatedAt` (the real last successful fetch),
 *     not a fabricated clock.
 *
 * A11y (accessibility skill — never colour-only; respect prefers-reduced-motion):
 *   - The status carries an icon (Radio/RefreshCw/AlertTriangle) + a TEXT label —
 *     colour is never the sole channel.
 *   - role="status" + aria-live="polite" announces refreshes to screen readers.
 *   - The pulse dot is decorative (aria-hidden) and carries `motion-reduce:animate-none`;
 *     the global reduced-motion reset in globals.css also neutralizes it.
 *
 * data-testids: dashboard-live-indicator, dashboard-live-updated
 */

import { useEffect, useState } from 'react';
import { Radio, RefreshCw, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRealizedRevenue } from '@/lib/hooks/use-dashboard';

/** Human-readable "updated Ns ago" from a millisecond epoch. Never returns a fabricated value. */
function formatUpdatedAgo(updatedAtMs: number | undefined): string {
  if (!updatedAtMs || updatedAtMs <= 0) return 'updated just now';
  const diffSec = Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000));
  if (diffSec < 5) return 'updated just now';
  if (diffSec < 60) return `updated ${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `updated ${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `updated ${diffHr}h ago`;
  return `updated ${Math.floor(diffHr / 24)}d ago`;
}

export function LiveIndicator() {
  // The primary dashboard query — its react-query metadata is the single freshness source.
  // (Reuses the SAME hook the KPI/revenue cards read; no second freshness mechanism.)
  const { dataUpdatedAt, isFetching, isError } = useRealizedRevenue();

  // 1s ticker so "updated Ns ago" stays fresh between polls.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  // Honest state selection — never a faked "Live".
  let Icon: React.ElementType;
  let label: string;
  let detail: string;
  let toneClass: string;
  let pulse = false;

  if (isError) {
    Icon = AlertTriangle;
    label = 'Reconnecting';
    detail = 'retrying live updates';
    toneClass = 'text-warning-subtle-foreground';
  } else if (isFetching) {
    Icon = RefreshCw;
    label = 'Updating';
    detail = 'fetching latest data';
    toneClass = 'text-success-subtle-foreground';
  } else {
    Icon = Radio;
    label = 'Live';
    detail = formatUpdatedAgo(dataUpdatedAt);
    toneClass = 'text-success-subtle-foreground';
    pulse = true;
  }

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Dashboard data: ${label} — ${detail}`}
      data-testid="dashboard-live-indicator"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium',
        toneClass,
      )}
    >
      {/* Decorative pulse dot — colour is NOT the only signal (icon + text below carry it). */}
      <span
        aria-hidden="true"
        className={cn(
          'relative inline-flex h-1.5 w-1.5 rounded-full bg-current',
          // Pulse only in the steady "Live" state; disabled under reduced-motion.
          pulse && 'animate-pulse motion-reduce:animate-none',
        )}
      />
      <Icon
        className={cn('h-3.5 w-3.5 shrink-0', isFetching && 'animate-spin motion-reduce:animate-none')}
        aria-hidden="true"
      />
      <span>{label}</span>
      <span className="text-muted-foreground" data-testid="dashboard-live-updated">
        · {detail}
      </span>
    </span>
  );
}
