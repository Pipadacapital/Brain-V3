'use client';

/**
 * SyncNowControl — feat-connector-sync-now (Track B)
 *
 * Renders a per-connector "Sync now" button + live status for a connected connector,
 * alongside BackfillControl. It triggers the SAME incremental trailing-window re-pull the
 * scheduler runs (overlap-locked server-side) — NOT a full backfill.
 *
 * Authz (sync = Owner/Brand-Admin/Manager per the data-ingestion spec — sync is lower-risk
 * than backfill, which stays brand_admin+):
 *   - owner / brand_admin / manager: trigger button rendered + enabled.
 *   - analyst:                       trigger button HIDDEN (not just disabled) — mirrors the server 403.
 *     The read-only status (badge + last-synced) is always visible so analysts can see a sync
 *     started by someone else.
 *
 * Live status (from connector_sync_status via useSyncStatus — REAL, never simulated):
 *   waiting_for_data / connected (no error) → idle / synced  (CheckCircle + last-synced date)
 *   syncing                                 → "Syncing…"     (Loader2 spin), button DISABLED + hint
 *   error                                   → "Failed"       (XCircle + last_error)
 *   error + TOKEN_EXPIRED/401 in last_error → reconnect prompt (sync-reconnect-required)
 *
 * Trigger error states (409):
 *   RECONNECT_REQUIRED                          → reconnect alert (sync-reconnect-required)
 *   SYNC_ALREADY_RUNNING | SYNC_ALREADY_REQUESTED → "already syncing" inline alert (no dup run)
 *   403                                         → button hidden (role constraint expected)
 *
 * A11y:
 *   - Status never colour-only: icon + text label on every state.
 *   - role="status" + aria-live="polite" on the live status region; role="alert" on errors.
 *   - Trigger button keyboard-reachable, visible focus ring (shadcn Button), aria-describedby hint.
 *
 * data-testids:
 *   sync-now-trigger, sync-now-status, sync-now-last-synced,
 *   sync-now-syncing-hint, sync-reconnect-required, sync-already-running.
 */

import { useState } from 'react';
import {
  CheckCircle,
  AlertTriangle,
  XCircle,
  Loader2,
  Clock,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { useSyncStatus, useTriggerSync } from '@/lib/hooks/use-sync-now';
import { useSessionRole } from '@/lib/hooks/use-session-role';
import { BffApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import type { SyncState } from '@/lib/api/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/** TOKEN_EXPIRED / 401 in last_error → the connector needs reconnecting. */
function isReconnectError(lastError: string | null): boolean {
  if (!lastError) return false;
  return /token_expired|reconnect|401|unauthor/i.test(lastError);
}

// ── Status badge (icon + label, never colour-only) ─────────────────────────────

type DisplayState = 'idle' | 'synced' | 'syncing' | 'failed';

function resolveDisplayState(syncState: SyncState, lastSyncAt: string | null): DisplayState {
  if (syncState === 'syncing') return 'syncing';
  if (syncState === 'error') return 'failed';
  // connected / waiting_for_data: synced if we have a real last_sync_at, else idle.
  return lastSyncAt ? 'synced' : 'idle';
}

function SyncStatusBadge({ state }: { state: DisplayState }) {
  const CONFIG = {
    idle: {
      icon: Clock,
      label: 'Not synced yet',
      cls: 'bg-muted text-muted-foreground',
      spin: false,
    },
    synced: {
      icon: CheckCircle,
      label: 'Synced',
      cls: 'bg-status-green-50 text-status-green-700',
      spin: false,
    },
    syncing: {
      icon: Loader2,
      label: 'Syncing…',
      cls: 'bg-blue-50 text-blue-700',
      spin: true,
    },
    failed: {
      icon: XCircle,
      label: 'Sync failed',
      cls: 'bg-status-red-50 text-status-red-700',
      spin: false,
    },
  } as const;

  const cfg = CONFIG[state];
  const Icon = cfg.icon;

  return (
    <span
      data-testid="sync-now-status"
      role="status"
      aria-label={`Sync status: ${cfg.label}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
        cfg.cls,
      )}
    >
      <Icon
        className={cn('h-3.5 w-3.5', cfg.spin && 'animate-spin')}
        aria-hidden="true"
      />
      {cfg.label}
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface SyncNowControlProps {
  /** connector_instance UUID — used to trigger /sync and poll /status. */
  connectorId: string;
  className?: string;
}

export function SyncNowControl({ connectorId, className }: SyncNowControlProps) {
  const role = useSessionRole();
  const canTrigger = role === 'owner' || role === 'brand_admin' || role === 'manager';

  // Controlled trigger-error state (RECONNECT_REQUIRED, SYNC_ALREADY_RUNNING, …).
  const [triggerError, setTriggerError] = useState<BffApiError | null>(null);

  const { mutate: trigger, isPending: isTriggering } = useTriggerSync(connectorId);
  const {
    data: status,
    isLoading: statusLoading,
    error: statusError,
    refetch: refetchStatus,
  } = useSyncStatus(connectorId);

  const syncState: SyncState = status?.sync_state ?? 'waiting_for_data';
  const lastSyncAt = status?.last_sync_at ?? null;
  const lastError = status?.last_error ?? null;
  const isSyncing = syncState === 'syncing';
  const display = resolveDisplayState(syncState, lastSyncAt);

  // Reconnect is needed when the live status reports an auth error, OR a trigger returned it.
  const needsReconnect =
    (syncState === 'error' && isReconnectError(lastError)) ||
    triggerError?.code === 'RECONNECT_REQUIRED';

  const alreadyRunning =
    triggerError?.code === 'SYNC_ALREADY_RUNNING' ||
    triggerError?.code === 'SYNC_ALREADY_REQUESTED';

  function handleTrigger() {
    setTriggerError(null);
    trigger(undefined, {
      onError: (err) => {
        if (err instanceof BffApiError) setTriggerError(err);
      },
    });
  }

  // Initial status fetch — skeleton until we have data (404 = never synced is handled below).
  if (statusLoading && !status) {
    return (
      <div className={cn('space-y-2', className)}>
        <Skeleton className="h-8 w-28" />
      </div>
    );
  }

  // A non-404 status read error is a real failure to surface.
  if (statusError instanceof BffApiError && statusError.status !== 404) {
    return (
      <div className={cn(className)}>
        <ErrorCard error={statusError} retry={refetchStatus} />
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {/* ── Live status row: badge + last-synced ─────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap" aria-live="polite">
        <SyncStatusBadge state={display} />
        {lastSyncAt && (
          <span
            data-testid="sync-now-last-synced"
            className="text-xs text-muted-foreground"
          >
            Last synced{' '}
            <time dateTime={lastSyncAt}>{formatDate(lastSyncAt)}</time>
          </span>
        )}
      </div>

      {/* ── RECONNECT_REQUIRED — token expired (honest, reuses health state) ──── */}
      {needsReconnect && (
        <div
          data-testid="sync-reconnect-required"
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-status-amber-300 bg-status-amber-50 p-3 text-sm text-status-amber-700"
        >
          <p className="font-medium flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            Connection expired
          </p>
          <p className="mt-1">
            Please reconnect this connector before syncing.
          </p>
        </div>
      )}

      {/* ── Already syncing (overlap lock held — no duplicate run) ────────────── */}
      {alreadyRunning && (
        <div
          data-testid="sync-already-running"
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700"
        >
          <p className="font-medium flex items-center gap-1.5">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            Sync already in progress
          </p>
          <p className="mt-1">
            A sync is already running for this connector.
          </p>
        </div>
      )}

      {/* ── Honest failure reason (state='error', non-reconnect) ──────────────── */}
      {syncState === 'error' && !needsReconnect && lastError && (
        <p className="text-sm text-status-red-700">
          Error: <span className="font-medium">{lastError}</span>
        </p>
      )}

      {/* ── Other trigger errors (not reconnect / not already-running) ────────── */}
      {triggerError &&
        triggerError.status !== 403 &&
        !needsReconnect &&
        !alreadyRunning && <ErrorCard error={triggerError} />}

      {/* ── Trigger button (brand_admin+ only) ───────────────────────────────── */}
      {canTrigger && (
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={handleTrigger}
            disabled={isTriggering || isSyncing}
            data-testid="sync-now-trigger"
            aria-label="Sync this connector now"
            aria-describedby="sync-now-hint"
            title={isSyncing ? 'Already syncing — please wait.' : undefined}
          >
            {isTriggering || isSyncing ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            )}
            {isSyncing ? 'Syncing…' : isTriggering ? 'Starting…' : 'Sync now'}
          </Button>

          {isSyncing ? (
            <p
              id="sync-now-hint"
              data-testid="sync-now-syncing-hint"
              className="text-xs text-muted-foreground"
              aria-live="polite"
            >
              Already syncing — please wait.
            </p>
          ) : (
            <p id="sync-now-hint" className="text-xs text-muted-foreground">
              Pulls the latest data from this connector now.
            </p>
          )}
        </>
      )}

      {/* manager / analyst see only the read-only status above — trigger hidden (D-15) */}
    </div>
  );
}
