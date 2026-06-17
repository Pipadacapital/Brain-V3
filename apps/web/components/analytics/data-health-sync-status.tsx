'use client';

/**
 * DataHealthSyncStatus — connector sync-state badge + honest live-vs-stale read.
 *
 * A11y (accessibility skill §status-never-colour-only):
 *   - Status is icon + text label, never colour alone. The icon glyph differs per state.
 *   - role="status" + aria-label carrying the full verdict (state + freshness).
 *   - Status token text uses -700 on -50 fill (4.5:1 contrast).
 *
 * Honesty: a connector is "stale" if the last ingest is old even when sync auth is fine
 * (kpi-dashboard-design §realized-vs-placed / data-quality). We never render a confident
 * "connected" over stale ingestion — the freshness verdict is computed from lastIngestAt,
 * independent of the raw connector state string.
 */

import * as React from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  Clock,
  HelpCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** Freshness verdict — derived from lastIngestAt, NOT from the connector state string. */
export type FreshnessVerdict = 'live' | 'lagging' | 'stale' | 'unknown';

/** Thresholds (hours). Tunable; honest defaults for an ingestion pipeline. */
const LAGGING_AFTER_HOURS = 6;
const STALE_AFTER_HOURS = 24;

export function freshnessFromIngest(lastIngestAt: string | null): {
  verdict: FreshnessVerdict;
  ageMs: number | null;
} {
  if (!lastIngestAt) return { verdict: 'unknown', ageMs: null };
  const ts = new Date(lastIngestAt).getTime();
  if (Number.isNaN(ts)) return { verdict: 'unknown', ageMs: null };
  const ageMs = Date.now() - ts;
  const ageHours = ageMs / 3_600_000;
  if (ageHours <= LAGGING_AFTER_HOURS) return { verdict: 'live', ageMs };
  if (ageHours <= STALE_AFTER_HOURS) return { verdict: 'lagging', ageMs };
  return { verdict: 'stale', ageMs };
}

const FRESHNESS_META: Record<
  FreshnessVerdict,
  { icon: React.ComponentType<{ className?: string }>; label: string; cls: string }
> = {
  live: {
    icon: CheckCircle2,
    label: 'Live',
    cls: 'bg-status-green-50 text-status-green-700',
  },
  lagging: {
    icon: Clock,
    label: 'Lagging',
    cls: 'bg-status-amber-50 text-status-amber-700',
  },
  stale: {
    icon: AlertTriangle,
    label: 'Stale',
    cls: 'bg-status-red-50 text-status-red-700',
  },
  unknown: {
    icon: HelpCircle,
    label: 'No ingestion yet',
    cls: 'bg-muted text-muted-foreground',
  },
};

/** Connector sync-state badge metadata — keyed off connector_sync_status.state. */
function syncStateMeta(state: string | null): {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  cls: string;
} {
  switch (state) {
    case 'connected':
      return { icon: CheckCircle2, label: 'Connected', cls: 'bg-status-green-50 text-status-green-700' };
    case 'syncing':
      return { icon: Loader2, label: 'Syncing', cls: 'bg-status-amber-50 text-status-amber-700' };
    case 'waiting_for_data':
      return { icon: Clock, label: 'Waiting for data', cls: 'bg-status-amber-50 text-status-amber-700' };
    case 'error':
      return { icon: XCircle, label: 'Error', cls: 'bg-status-red-50 text-status-red-700' };
    case null:
    case undefined:
      return { icon: HelpCircle, label: 'No connector', cls: 'bg-muted text-muted-foreground' };
    default:
      return { icon: HelpCircle, label: state, cls: 'bg-muted text-muted-foreground' };
  }
}

interface FreshnessBadgeProps {
  verdict: FreshnessVerdict;
  className?: string;
}

/** FreshnessBadge — the honest live-vs-stale read (icon + label, never colour-only). */
export function FreshnessBadge({ verdict, className }: FreshnessBadgeProps) {
  const m = FRESHNESS_META[verdict];
  const Icon = m.icon;
  return (
    <span
      role="status"
      aria-label={`Data freshness: ${m.label}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        m.cls,
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{m.label}</span>
    </span>
  );
}

interface SyncStateBadgeProps {
  state: string | null;
  className?: string;
}

/** SyncStateBadge — raw connector state (icon + label, never colour-only). */
export function SyncStateBadge({ state, className }: SyncStateBadgeProps) {
  const m = syncStateMeta(state);
  const Icon = m.icon;
  const spin = state === 'syncing';
  return (
    <span
      role="status"
      aria-label={`Connector state: ${m.label}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        m.cls,
        className,
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', spin && 'animate-spin')} aria-hidden="true" />
      <span className="capitalize">{m.label}</span>
    </span>
  );
}
