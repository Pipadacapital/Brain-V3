'use client';

import { useEffect, useState } from 'react';
import { Unplug, CheckCircle, XCircle, Clock, Radio } from 'lucide-react';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { useConnectionStatus } from '@/lib/hooks/use-dashboard';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { SyncState } from '@/lib/api/types';

/**
 * Connection Status widget
 * Source: connector_instance.status, connector_sync_status.state + .last_sync_at
 * (Postgres control-plane ONLY — arch plan §6.4)
 *
 * A11y: status is NEVER colour-only — always paired with icon + text label.
 *
 * Live-sync indicator (C1 — feat-shopify-live-connector):
 *   sync_state='syncing'             → "Syncing…" (animated amber, Clock icon)
 *   sync_state='connected' + recent  → "Live" (green, Radio icon; recent = last_sync_at ≤5 min ago)
 *   sync_state='connected' + stale   → "Connected" + freshness "Last synced X ago"
 *   sync_state='waiting_for_data'    → "Waiting for data" (muted, Clock icon)
 *   sync_state='error'               → "Error" (red, XCircle icon)
 *
 * Honesty: "Live" is NEVER faked. It reflects real connector_sync_status.state +
 * last_sync_at. If last_sync_at is absent or older than LIVE_THRESHOLD_MS, the pill
 * shows "Connected" (not "Live") + an honest freshness read.
 *
 * data-testids: connection-live-indicator, connection-freshness
 */

/** 5 minutes — threshold under which a connected connector is considered "Live". */
const LIVE_THRESHOLD_MS = 5 * 60 * 1000;

/** Format a relative time from a timestamp string to a human-readable string.
 *  Uses Intl.RelativeTimeFormat (built-in, no dep). Returns null if ts is null/invalid. */
function formatRelativeTime(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (diffSec < 60) return rtf.format(-diffSec, 'second');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return rtf.format(-diffMin, 'minute');
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return rtf.format(-diffHr, 'hour');
  return rtf.format(-Math.floor(diffHr / 24), 'day');
}

/** Returns true when connector is live: connected state + last_sync_at within threshold. */
function isLive(syncState: SyncState | null, lastSyncAt: string | null): boolean {
  if (syncState !== 'connected' || !lastSyncAt) return false;
  const d = new Date(lastSyncAt);
  if (isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() <= LIVE_THRESHOLD_MS;
}

// ── State display config (base — never colour-only, a11y) ─────────────────────

type PillCfg = { icon: React.ElementType; label: string; ariaLabel: string; tone: StatusTone };

const SYNC_STATE_CONFIG: Record<SyncState, PillCfg> = {
  connected: {
    icon: CheckCircle,
    label: 'Connected',
    ariaLabel: 'Connector status: Connected',
    tone: 'success',
  },
  syncing: {
    icon: Clock,
    label: 'Syncing',
    ariaLabel: 'Connector status: Syncing data',
    tone: 'warning',
  },
  waiting_for_data: {
    icon: Clock,
    label: 'Waiting for data',
    ariaLabel: 'Connector status: Waiting for data',
    tone: 'neutral',
  },
  error: {
    icon: XCircle,
    label: 'Error',
    ariaLabel: 'Connector status: Error',
    tone: 'destructive',
  },
};

// ── Live pill config (overrides 'connected' when last_sync_at is recent) ─────

const LIVE_CONFIG: PillCfg = {
  icon: Radio,
  label: 'Live',
  ariaLabel: 'Connector status: Live — actively syncing',
  tone: 'success',
};

// ── LiveSyncIndicator ─────────────────────────────────────────────────────────

/**
 * Renders the live-sync status pill + optional freshness text.
 *
 * Honesty contract: "Live" only shows when sync_state='connected' AND last_sync_at
 * is within LIVE_THRESHOLD_MS. A stale connector shows "Connected" + "Last synced…".
 *
 * Updates the freshness text every 30s using a client-side ticker — no server round-trip.
 * data-testids: connection-live-indicator, connection-freshness
 */
function LiveSyncIndicator({
  syncState,
  lastSyncAt,
}: {
  syncState: SyncState;
  lastSyncAt: string | null;
}) {
  // Ticker: re-render every 30s so relative time stays fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const live = isLive(syncState, lastSyncAt);
  const syncing = syncState === 'syncing';

  const pillCfg: PillCfg = live ? LIVE_CONFIG : SYNC_STATE_CONFIG[syncState];
  const PillIcon = pillCfg.icon;

  // Freshness text: shown for connected (non-live) and live states
  const showFreshness = (syncState === 'connected' || live) && lastSyncAt;
  const relativeTime = showFreshness ? formatRelativeTime(lastSyncAt) : null;

  return (
    <div className="flex flex-col gap-1.5">
      {/* Status pill — icon + label + role="status" — never colour-only (a11y) */}
      <StatusBadge
        tone={pillCfg.tone}
        pulse={live || syncing}
        role="status"
        aria-label={pillCfg.ariaLabel}
        data-testid="connection-live-indicator"
        hideDot
        className="self-start px-2.5 py-1 text-sm"
      >
        <PillIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        {pillCfg.label}
        {syncing && '…'}
      </StatusBadge>

      {/* Freshness text — honest relative time from last_sync_at */}
      {relativeTime && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="connection-freshness"
          aria-live="polite"
        >
          {live ? `Live · synced ${relativeTime}` : `Last synced ${relativeTime}`}
        </p>
      )}

      {/* Waiting for data: no last_sync_at → show honest "No sync yet" */}
      {syncState === 'waiting_for_data' && !lastSyncAt && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="connection-freshness"
        >
          No sync yet — data will appear once connected
        </p>
      )}
    </div>
  );
}

export function ConnectionStatusCard() {
  const { data, isLoading, error, refetch } = useConnectionStatus();

  if (isLoading) {
    return (
      <SectionCard title="Connection status" className="h-full">
        <div className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
      </SectionCard>
    );
  }

  if (error) {
    return (
      <SectionCard title="Connection status" className="h-full">
        <ErrorCard error={error} retry={refetch} />
      </SectionCard>
    );
  }

  // Disconnected: the connector existed and was disconnected. The client maps
  // sync_state→null when not connected, so we MUST branch on connector_status here
  // (BEFORE the no-data empty state) — otherwise a disconnected source wrongly reads
  // "No Data Yet". Honest: the already-ingested data is retained; we say so.
  if (data && data.connector_status === 'disconnected') {
    const rel = formatRelativeTime(data.last_sync_at);
    return (
      <SectionCard title="Connection status" className="h-full" data-testid="connection-status-card">
        <StatusBadge
          tone="neutral"
          hideDot
          role="status"
          aria-label="Connector status: Disconnected"
          data-testid="connection-disconnected-indicator"
          className="self-start px-2.5 py-1 text-sm"
        >
          <Unplug className="h-4 w-4 shrink-0" aria-hidden="true" />
          Disconnected
        </StatusBadge>
        <p className="text-xs text-muted-foreground mt-2" data-testid="connection-freshness">
          {rel ? `Showing last-synced data · synced ${rel}` : 'Showing last-synced data'}
        </p>
        <Button asChild size="sm" variant="outline" className="mt-3">
          <Link href="/settings/connectors">Reconnect</Link>
        </Button>
      </SectionCard>
    );
  }

  if (!data || !data.sync_state) {
    return (
      <SectionCard title="Connection status" className="h-full" data-testid="connection-status-card">
        <EmptyState
          compact
          title="Not connected yet"
          description="Connect a data source to see connection status."
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/settings/connectors">Connect data source</Link>
            </Button>
          }
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Connection status" className="h-full" data-testid="connection-status-card">
      {data.provider && (
        <p className="text-xs capitalize text-muted-foreground mb-2">{data.provider}</p>
      )}
      {/* C1: Live-sync indicator — reflects real connector_sync_status; never faked */}
      <LiveSyncIndicator syncState={data.sync_state} lastSyncAt={data.last_sync_at} />
    </SectionCard>
  );
}
